// X Videos queries: the clips the watcher finds, the work queue of each clip, the desk's Refresh requests, and the
// reads the API needs.
// The queue works like the publish outbox (queue.ts): claims use FOR UPDATE SKIP LOCKED, a lease that runs out puts
// the job back, and a step fails the clip after XV_MAX_ATTEMPTS tries (handled errors and crashes alike). Every
// finish / fail / defer names the lease it holds, so a worker that outlived its lease cannot undo a newer claim.

import { and, desc, eq, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import type { Db, Executor } from "@socia/db";
import { xvClips, xvEvidence, xvJobs, xvScanRequests, type XvClipRow, type XvClipStatus, type XvEvidence, type XvJobRow, type XvStep } from "./schema";

export const XV_MAX_ATTEMPTS = 3;
/** Rows per INSERT / IN list: well under Postgres's 65,535 parameters */
const CHUNK = 500;
/** A clip seen again with nothing changed is only touched this often (last_seen_at), not on every scan */
const SEEN_REFRESH = "10 minutes";
/** Seconds before a failed step is tried again: 30 s, then 2 min */
const retryDelay = (attempts: number) => (attempts <= 1 ? 30 : 120);

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** A settled video file as the watcher found it */
export interface XvSeenFile {
  folder: string[];
  fileName: string;
  size: number;
  mtime: Date;
  fingerprint: string;
  picked: boolean;
  done: boolean;
  title: string;
  /** The day folder's date, "2026-11-27" */
  day: string;
  /** The title the name holds, or null (rules xvHeading) */
  heading: string | null;
}

/**
 * Records the settled files of one scan. A fingerprint the day already has is updated in place (the desk renamed it:
 * x → x…done, or moved it to another folder of the day) and comes back from `gone`; a new one is inserted. Every clip
 * with no probe job gets one and turns `reading`. Two files of one day with one fingerprint (a copy in a second folder)
 * are one clip: the picked one wins, else the last listed. Returns how many clips were new and how many were queued.
 */
export async function xvRecordScan(db: Db, orgId: string, files: readonly XvSeenFile[]): Promise<{ inserted: number; queued: number }> {
  const byFp = new Map<string, XvSeenFile>();
  for (const f of files) {
    const key = `${f.day}/${f.fingerprint}`;
    const had = byFp.get(key);
    if (!had || f.picked || !had.picked) byFp.set(key, f);
  }
  const unique = [...byFp.values()];
  if (!unique.length) return { inserted: 0, queued: 0 };
  return db.transaction(async (tx) => {
    let inserted = 0;
    const toQueue: string[] = [];
    for (const part of chunks(unique)) {
      const rows = await tx
        .insert(xvClips)
        .values(part.map((f) => ({ orgId, ...f, folder: [...f.folder], settledAt: sql`now()` })))
        .onConflictDoUpdate({
          target: [xvClips.orgId, xvClips.day, xvClips.fingerprint],
          set: {
            folder: sql`excluded.folder`,
            fileName: sql`excluded.file_name`,
            picked: sql`excluded.picked`,
            done: sql`excluded.done`,
            title: sql`excluded.title`,
            heading: sql`excluded.heading`,
            lastSeenAt: sql`now()`,
            goneAt: null,
            // Back from gone: `seen` for a moment, then the state its jobs say (restoreStatus)
            status: sql`case when ${xvClips.status} = 'gone' then 'seen' else ${xvClips.status} end`,
            updatedAt: sql`now()`,
          },
          // Only rows that changed, came back, or were last touched a while ago: a scan does not rewrite every clip
          setWhere: sql`${xvClips.fileName} is distinct from excluded.file_name
            or ${xvClips.folder} is distinct from excluded.folder
            or ${xvClips.status} = 'gone'
            or ${xvClips.lastSeenAt} < now() - interval '${sql.raw(SEEN_REFRESH)}'`,
        })
        .returning({ id: xvClips.id, status: xvClips.status, inserted: sql<boolean>`xmax = 0` });
      inserted += rows.filter((r) => r.inserted).length;
      toQueue.push(...rows.filter((r) => r.status === "seen").map((r) => r.id));
    }
    const queued = await queueStep(tx, toQueue, "probe");
    await restoreStatus(tx, toQueue);
    return { inserted, queued };
  });
}

/** Adds `step` for the clips that do not have it yet, and marks them reading. Returns how many were queued. */
async function queueStep(tx: Executor, clipIds: readonly string[], step: XvStep): Promise<number> {
  let queued = 0;
  for (const part of chunks(clipIds)) {
    const added = await tx
      .insert(xvJobs)
      .values(part.map((clipId) => ({ clipId, step })))
      .onConflictDoNothing({ target: [xvJobs.clipId, xvJobs.step] })
      .returning({ clipId: xvJobs.clipId });
    if (added.length) {
      await tx
        .update(xvClips)
        .set({ status: "reading", progress: sql`coalesce(${xvClips.progress}, 0)`, updatedAt: sql`now()` })
        .where(and(inArray(xvClips.id, added.map((a) => a.clipId)), sql`${xvClips.status} <> 'gone'`));
    }
    queued += added.length;
  }
  return queued;
}

/**
 * A clip still `seen` that already has jobs (it came back from `gone`) takes the state its jobs say: failed,
 * ready (`new`, every step done) or `reading`
 */
async function restoreStatus(tx: Executor, clipIds: readonly string[]): Promise<void> {
  for (const part of chunks(clipIds)) {
    await tx.execute(sql`
      update xvideos.clip c set status = j.state, updated_at = now()
      from (
        select clip_id, case when bool_or(status = 'failed') then 'failed' when bool_and(status = 'done') then 'new' else 'reading' end as state
        from xvideos.clip_job where clip_id in ${part} group by clip_id
      ) j
      where c.id = j.clip_id and c.status = 'seen'`);
  }
}

/**
 * Marks `gone` the clips of a fully scanned day folder that the scan did not see. Only call it after the whole day
 * folder was listed: a scan cut short by the share must not take clips off the desk.
 */
export async function xvMarkGone(db: Db, orgId: string, dayFolder: readonly string[], seen: readonly string[]): Promise<number> {
  if (!dayFolder.length) throw new Error("xvMarkGone needs the day folder");
  const prefix = dayFolder.length;
  const rows = await db
    .update(xvClips)
    .set({ status: "gone", goneAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(xvClips.orgId, orgId),
        // Folder parts never hold a slash (a Windows name cannot), so the joined prefix compares exactly
        sql`array_to_string(${xvClips.folder}[1:${sql.raw(String(prefix))}], '/') = ${dayFolder.join("/")}`,
        sql`${xvClips.status} <> 'gone'`,
        seen.length ? notInArray(xvClips.fingerprint, [...new Set(seen)]) : sql`true`,
      ),
    )
    .returning({ id: xvClips.id });
  return rows.length;
}

/**
 * Marks `gone` the clips of a month folder whose whole day folder has left the share (all of them when `dayNames` is
 * empty: the month folder itself is gone). Only call it after the month folder was listed in full.
 */
export async function xvMarkGoneDays(db: Db, orgId: string, monthFolder: readonly string[], dayNames: readonly string[]): Promise<number> {
  if (monthFolder.length !== 2) throw new Error("xvMarkGoneDays needs the year and month folder");
  const rows = await db
    .update(xvClips)
    .set({ status: "gone", goneAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(xvClips.orgId, orgId),
        sql`array_to_string(${xvClips.folder}[1:2], '/') = ${monthFolder.join("/")}`,
        sql`${xvClips.status} <> 'gone'`,
        dayNames.length ? sql`not (${xvClips.folder}[3] = any(${sql.param([...dayNames])}::text[]))` : sql`true`,
      ),
    )
    .returning({ id: xvClips.id });
  return rows.length;
}

/**
 * The month folders (["2026", "November 2026"], as on the share) that still have clips on the desk: the watcher keeps
 * checking them until every clip in them is gone, also after the month has ended
 */
export async function xvLiveMonths(db: Db, orgId: string): Promise<[string, string][]> {
  const rows = await db.execute<{ y: string; m: string }>(sql`
    select distinct folder[1] as y, folder[2] as m from xvideos.clip
    where org_id = ${orgId} and status <> 'gone' and folder[1] is not null and folder[2] is not null`);
  return rows.rows.map((r) => [r.y, r.m]);
}

/** The desk's Refresh: walk this day folder now. A second press before the watcher took it only moves its time. */
export async function xvRequestScan(db: Db, orgId: string, day: string): Promise<void> {
  await db
    .insert(xvScanRequests)
    .values({ orgId, day })
    .onConflictDoUpdate({ target: [xvScanRequests.orgId, xvScanRequests.day], set: { requestedAt: sql`now()` } });
}

/** Takes (and removes) the Refresh requests waiting, oldest first */
export async function xvTakeScanRequests(db: Db, orgId: string): Promise<string[]> {
  const rows = await db.delete(xvScanRequests).where(eq(xvScanRequests.orgId, orgId)).returning({ day: xvScanRequests.day, at: xvScanRequests.requestedAt });
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime()).map((r) => r.day);
}

/** A claimed job: finish / fail / defer it with this object, which carries the lease it holds */
export type XvClaimedJob = XvJobRow & { leaseUntil: Date; clip: XvClipRow };

/** The job row this worker still holds: running, with the lease it was given */
const holds = (job: Pick<XvClaimedJob, "id" | "leaseUntil">) =>
  and(eq(xvJobs.id, job.id), eq(xvJobs.status, "running"), eq(xvJobs.leaseUntil, job.leaseUntil));

/**
 * Claims the oldest due job of `step` for `leaseSeconds`, or null: first a pending one that is due, else one whose
 * worker died (running, lease run out). A died-on job that has used all its attempts fails its clip instead of being
 * run again (a clip that crashes the worker). Jobs of clips that left the share wait for them to come back.
 */
export async function xvClaimJob(db: Db, step: XvStep, leaseSeconds: number): Promise<XvClaimedJob | null> {
  return db.transaction(async (tx) => {
    const notGone = sql`not exists (select 1 from xvideos.clip c where c.id = ${xvJobs.clipId} and c.status = 'gone')`;
    const pick = (where: ReturnType<typeof and>) =>
      tx.select({ id: xvJobs.id, attempts: xvJobs.attempts, clipId: xvJobs.clipId }).from(xvJobs).where(where).orderBy(xvJobs.nextAttemptAt).limit(1).for("update", { skipLocked: true });

    let due = await pick(and(eq(xvJobs.step, step), eq(xvJobs.status, "pending"), sql`${xvJobs.nextAttemptAt} <= now()`, notGone));
    if (!due.length) {
      due = await pick(and(eq(xvJobs.step, step), eq(xvJobs.status, "running"), lt(xvJobs.leaseUntil, sql`now()`), notGone));
      const dead = due[0];
      if (dead && dead.attempts >= XV_MAX_ATTEMPTS) {
        const reason = `${step}: stopped ${dead.attempts} times without finishing (the worker crashed or was stopped on this clip)`;
        await tx.update(xvJobs).set({ status: "failed", leaseUntil: null, error: reason, updatedAt: sql`now()` }).where(eq(xvJobs.id, dead.id));
        await tx.update(xvClips).set({ status: "failed", progress: null, error: reason, updatedAt: sql`now()` }).where(eq(xvClips.id, dead.clipId));
        return null;
      }
    }
    if (!due.length) return null;
    const [job] = await tx
      .update(xvJobs)
      // Lease time to the millisecond, so it compares exactly when the worker hands it back (timestamptz keeps µs)
      .set({ status: "running", attempts: sql`${xvJobs.attempts} + 1`, leaseUntil: sql`date_trunc('milliseconds', now() + make_interval(secs => ${leaseSeconds}))`, updatedAt: sql`now()` })
      .where(eq(xvJobs.id, due[0]!.id))
      .returning();
    const [clip] = await tx.select().from(xvClips).where(eq(xvClips.id, job!.clipId));
    return { ...job!, leaseUntil: job!.leaseUntil!, clip: clip! };
  });
}

/** Done with this step; queues `next` when given, else the clip is ready (`new`). False when the lease was lost. */
export async function xvFinishJob(db: Db, job: Pick<XvClaimedJob, "id" | "clipId" | "leaseUntil">, next: XvStep | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(xvJobs).set({ status: "done", leaseUntil: null, error: null, updatedAt: sql`now()` }).where(holds(job)).returning({ id: xvJobs.id });
    if (!done.length) return false;
    if (next) await queueStep(tx, [job.clipId], next);
    else {
      await tx
        .update(xvClips)
        .set({ status: "new", progress: null, error: null, updatedAt: sql`now()` })
        .where(and(eq(xvClips.id, job.clipId), sql`${xvClips.status} <> 'gone'`));
    }
    return true;
  });
}

/** The step failed: retried later, or after XV_MAX_ATTEMPTS the clip is `failed` with the reason. "lost": the lease was gone. */
export async function xvFailJob(db: Db, job: Pick<XvClaimedJob, "id" | "clipId" | "attempts" | "leaseUntil">, error: string): Promise<"retry" | "failed" | "lost"> {
  const message = error.slice(0, 500);
  const final = job.attempts >= XV_MAX_ATTEMPTS;
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(xvJobs)
      .set({
        status: final ? "failed" : "pending",
        leaseUntil: null,
        error: message,
        nextAttemptAt: sql`now() + make_interval(secs => ${retryDelay(job.attempts)})`,
        updatedAt: sql`now()`,
      })
      .where(holds(job))
      .returning({ id: xvJobs.id });
    if (!rows.length) return "lost";
    if (final) {
      await tx
        .update(xvClips)
        .set({ status: "failed", progress: null, error: message, updatedAt: sql`now()` })
        .where(and(eq(xvClips.id, job.clipId), sql`${xvClips.status} <> 'gone'`));
    }
    return final ? "failed" : "retry";
  });
}

/** Gives the job back without counting an attempt (the media service is down or busy, the file is being renamed) */
export async function xvDeferJob(db: Db, job: Pick<XvClaimedJob, "id" | "leaseUntil">, seconds: number, reason: string): Promise<void> {
  await db
    .update(xvJobs)
    .set({ status: "pending", attempts: sql`greatest(${xvJobs.attempts} - 1, 0)`, leaseUntil: null, error: reason.slice(0, 500), nextAttemptAt: sql`now() + make_interval(secs => ${seconds})`, updatedAt: sql`now()` })
    .where(holds(job));
}

export interface XvProbe {
  durationS: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  hasAudio: boolean;
  posterKey: string | null;
}

export async function xvSaveProbe(db: Db, clipId: string, probe: XvProbe): Promise<void> {
  await db.update(xvClips).set({ ...probe, progress: 10, updatedAt: sql`now()` }).where(eq(xvClips.id, clipId));
}

export async function xvSetProgress(db: Db, clipId: string, progress: number): Promise<void> {
  await db.update(xvClips).set({ progress: Math.max(0, Math.min(100, Math.round(progress))), updatedAt: sql`now()` }).where(eq(xvClips.id, clipId));
}

export async function xvSaveEvidence(db: Db, clipId: string, evidence: XvEvidence): Promise<void> {
  await db
    .insert(xvEvidence)
    .values({ clipId, mediaVersion: evidence.mediaVersion, evidence })
    .onConflictDoUpdate({ target: xvEvidence.clipId, set: { mediaVersion: evidence.mediaVersion, evidence, createdAt: sql`now()` } });
}

// ─── reads for the API ───────────────────────────────────────────────────────

export interface XvListOptions {
  /** One day folder's clips, "2026-11-27" */
  day: string;
  statuses?: readonly XvClipStatus[];
  limit?: number;
}

/** One day folder's clips, every video (x-marked or not), newest file first */
export async function xvListClips(db: Db, orgId: string, opts: XvListOptions): Promise<XvClipRow[]> {
  const where = [eq(xvClips.orgId, orgId), eq(xvClips.day, opts.day)];
  if (opts.statuses?.length) where.push(inArray(xvClips.status, [...opts.statuses]));
  return db
    .select()
    .from(xvClips)
    .where(and(...where))
    .orderBy(desc(xvClips.mtime))
    .limit(Math.min(opts.limit ?? 500, 1000));
}

export interface XvDayCount {
  /** "2026-11-27" */
  day: string;
  /** Videos on the share */
  clips: number;
  /** Of them, x-marked */
  picked: number;
  /** Of them, marked done */
  done: number;
}

/**
 * The day folders that hold videos now, newest first: the desk's month / day selector. A file cleared from the share
 * is gone for good, so a day whose files are all gone is not listed.
 */
export async function xvListDays(db: Db, orgId: string): Promise<XvDayCount[]> {
  const rows = await db
    .select({
      day: xvClips.day,
      clips: sql<number>`count(*)::int`,
      picked: sql<number>`(count(*) filter (where ${xvClips.picked}))::int`,
      done: sql<number>`(count(*) filter (where ${xvClips.done}))::int`,
    })
    .from(xvClips)
    .where(and(eq(xvClips.orgId, orgId), ne(xvClips.status, "gone"), isNotNull(xvClips.day)))
    .groupBy(xvClips.day)
    .orderBy(desc(xvClips.day));
  return rows.filter((r): r is XvDayCount => r.day !== null);
}

export async function xvGetClip(db: Db, orgId: string, id: string): Promise<{ clip: XvClipRow; evidence: XvEvidence | null } | null> {
  const rows = await db
    .select({ clip: xvClips, evidence: xvEvidence.evidence })
    .from(xvClips)
    .leftJoin(xvEvidence, eq(xvEvidence.clipId, xvClips.id))
    .where(and(eq(xvClips.orgId, orgId), eq(xvClips.id, id)));
  const row = rows[0];
  return row ? { clip: row.clip, evidence: row.evidence ?? null } : null;
}
