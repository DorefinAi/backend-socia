// Ops status for the Sentry control centre (dev-docs/ops-status-contract.md), pipeline "digital": what the breaking-news
// pipeline did on an IST day, what is waiting where right now, one story's trace, and the desk's sign-ins. Read-only;
// served by routes/owner.ts under the owner key. Every number comes from a table; what this backend cannot know is
// null (a time) or 0 (a count), never guessed.
//
// Where each stage's numbers come from (contract §1.1):
//   ingest   count: stories created on the day. waiting: 0 (files settling on the share live only in the worker's memory)
//            failed: ops_log errors "could not ingest file" on the day
//   convert  count: file stories created on the day that got past conversion. waiting: stories in status "ingested"
//            failed: stories failed on the day (status failed, updated_at), except the compose failures
//   compose  count: drafts created on the day. waiting: stories in status "converted"
//            failed: stories failed on the day by the compose stage ("Could not compose this file: …")
//   render   count: ops_log "card rendered" lines on the day. waiting: drafts whose card is behind its text
//            failed: ops_log "card render failed" errors on the day
//   operator count: drafts Copy & Posted / Marked posted / Approved / Rejected on the day (audit_log, distinct drafts).
//            waiting: drafts in ready / claimed whose story reached the desk on the day (the desk's day queue)
//   publish  count: posts recorded on the day (published_posts), by hand or by the API. waiting: 0 (see queues)
//            failed: publish jobs given up on the day
// Web Scraper drafts (stories.source "trend") are not part of this pipeline and are left out everywhere.

import { istDayRange } from "@socia/core";
import { istDate, readDataFileStatus, readIngestStatus, readOpsHeartbeats, readWorkerHeartbeat, redactText, workerLiveness, type Db } from "@socia/db";
import { sql, type SQL } from "drizzle-orm";
import { HttpError } from "./auth";
import { sourceState } from "./routes/status";

// ─── Limits and ids ──────────────────────────────────────────────────────────

/**
 * Contract §1.2: an item is "stuck" once it has waited in one stage longer than this many minutes. The one place to
 * change them. Sentry may apply tighter limits of its own on top. publish has none (no auto publish in phase 1).
 */
export const STUCK_LIMIT_MINUTES = {
  ingest: 10,
  convert: 10,
  compose: 10,
  render: 10,
  operator: 60,
} as const satisfies Partial<Record<DigitalStage, number>>;

/** The digital pipeline's stages, in pipeline order (contract §1.1) */
export const DIGITAL_STAGES = ["ingest", "convert", "compose", "render", "operator", "publish"] as const;
export type DigitalStage = (typeof DIGITAL_STAGES)[number];
export type StoryState = "on_track" | "stuck" | "failed" | "done";
export type StepState = "done" | "waiting" | "failed" | "skipped";

/** Contract caps */
export const STUCK_MAX = 50;
export const STORIES_DEFAULT_LIMIT = 20;
export const STORIES_MAX_LIMIT = 50;
export const LOGINS_MAX = 2000;
export const ACTIVE_SESSIONS_MAX = 500;

/** How a story failed in compose (worker stages/isolate.ts: `Could not ${stage} this file: …`) */
const COMPOSE_FAILED_PREFIX = "Could not compose";
/** audit_log.entity_id is text: only a uuid is joined to a draft (anything else would fail the cast) */
const UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
/** A draft withdrawn by a bad re-save (worker stages/convert.ts WITHDRAWN_NOTE): the failure is the file's, not publishing's */
const WITHDRAWN_PREFIX = "The file was saved again and can't be used: ";
/** The worker's log messages counted here (stages/render.ts, stages/ingest.ts, stages/convert.ts) */
const MSG = {
  rendered: "card rendered",
  renderFailed: "card render failed",
  ingestFailed: "could not ingest file",
  converted: ["breaking file converted", "story converted"],
} as const;
/** audit_log actions on a draft that count as an operator acting on it */
const POSTED_ACTIONS = ["draft.copy_posted", "draft.mark_posted", "draft.approve"] as const;
const OPERATOR_ACTIONS = [...POSTED_ACTIONS, "draft.reject"] as const;

// ─── Small helpers ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const dateOf = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const isoOf = (v: unknown) => dateOf(v)?.toISOString() ?? null;
const strOf = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const rowsOf = async (db: Db, q: SQL) => ((await db.execute(q)).rows ?? []) as Row[];
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

export interface OpsDay {
  /** YYYY-MM-DD, the IST day */
  date: string;
  start: Date;
  end: Date;
}

/** `date=YYYY-MM-DD` as an IST day [00:00, 24:00) +05:30; missing = today in IST; anything else is 400 invalid */
export function opsDay(date: string | undefined, now = new Date()): OpsDay {
  const day = date ?? istDate(now);
  const range = istDayRange(day);
  if (!range) throw new HttpError(400, "invalid", "date must be a real day as YYYY-MM-DD, e.g. 2026-11-20.");
  return { date: day, ...range };
}

// ─── Where a story is ────────────────────────────────────────────────────────

/** A story and its X draft, as the queries below select them (snake_case from SQL, read by storyRow) */
export interface StoryRow {
  id: string;
  slug: string;
  headline: string | null;
  status: string;
  source: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  receivedAt: Date;
  draftId: string | null;
  draftStatus: string | null;
  cardRev: number;
  cardRenderedRev: number;
  renderError: string | null;
  draftCreatedAt: Date | null;
  draftUpdatedAt: Date | null;
}

const STORY_COLS = sql.raw(`s.id::text AS id, s.slug, s.headline, s.status, s.source, s.last_error, s.created_at, s.updated_at, s.received_at,
  d.id::text AS draft_id, d.status AS draft_status, d.card_rev, d.card_rendered_rev, d.render_error, d.created_at AS draft_created_at, d.updated_at AS draft_updated_at`);
const STORY_FROM = sql.raw(`stories s LEFT JOIN post_drafts d ON d.story_id = s.id AND d.platform = 'x'`);

export function storyRow(r: Row): StoryRow {
  return {
    id: String(r.id),
    slug: String(r.slug ?? ""),
    headline: strOf(r.headline),
    status: String(r.status ?? ""),
    source: String(r.source ?? ""),
    lastError: strOf(r.last_error),
    createdAt: dateOf(r.created_at) ?? new Date(0),
    updatedAt: dateOf(r.updated_at) ?? dateOf(r.created_at) ?? new Date(0),
    receivedAt: dateOf(r.received_at) ?? dateOf(r.created_at) ?? new Date(0),
    draftId: strOf(r.draft_id),
    draftStatus: strOf(r.draft_status),
    cardRev: num(r.card_rev),
    cardRenderedRev: num(r.card_rendered_rev),
    renderError: strOf(r.render_error),
    draftCreatedAt: dateOf(r.draft_created_at),
    draftUpdatedAt: dateOf(r.draft_updated_at),
  };
}

export interface StoryPosition {
  stage: DigitalStage;
  state: StoryState;
  /** When it started waiting in `stage`; null when it is not waiting */
  since: Date | null;
  /** Minutes waited so far; null when not waiting */
  minutes: number | null;
}

const waiting = (stage: DigitalStage, since: Date, now: Date): StoryPosition => {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  const limit = (STUCK_LIMIT_MINUTES as Partial<Record<DigitalStage, number>>)[stage];
  return { stage, state: limit !== undefined && minutes > limit ? "stuck" : "on_track", since, minutes };
};
const settled = (stage: DigitalStage, state: "failed" | "done"): StoryPosition => ({ stage, state, since: null, minutes: null });

/** The stage a story is in now and how it is doing there (contract §2 `stage` / `state`) */
export function storyPosition(s: StoryRow, now = new Date()): StoryPosition {
  if (s.status === "failed") return settled(s.lastError?.startsWith(COMPOSE_FAILED_PREFIX) ? "compose" : "convert", "failed");
  if (s.status === "ingested") return waiting("convert", s.updatedAt, now);
  if (s.status === "converted") return waiting("compose", s.updatedAt, now);
  // composed (or archived): where its draft is
  const since = s.draftUpdatedAt ?? s.updatedAt;
  switch (s.draftStatus) {
    case null:
      return settled("compose", "done");
    case "rendering":
      return waiting("render", since, now);
    case "render_failed":
      return settled("render", "failed");
    case "ready":
    case "claimed":
      // A card asked for and not drawn yet waits in render; otherwise the draft waits for the desk since it arrived
      if (s.cardRev > 0 && s.cardRenderedRev < s.cardRev) return waiting("render", since, now);
      return waiting("operator", s.draftCreatedAt ?? since, now);
    case "queued":
    case "publishing":
      return waiting("publish", since, now);
    case "published":
    case "recalled":
      return settled("publish", "done");
    case "rejected":
      return settled("operator", "done");
    case "failed":
      return settled(s.renderError?.startsWith(WITHDRAWN_PREFIX) ? "convert" : "publish", "failed");
    default:
      return settled("operator", "done");
  }
}

// ─── GET /owner/ops/summary ──────────────────────────────────────────────────

export interface OpsSummaryOptions {
  phase: 1 | 2;
  now?: Date;
}

export async function opsSummary(db: Db, day: OpsDay, opts: OpsSummaryOptions) {
  const now = opts.now ?? new Date();
  const s = ts(day.start);
  const e = ts(day.end);
  const inDay = (col: string) => sql`${sql.raw(col)} >= ${s} AND ${sql.raw(col)} < ${e}`;
  const notTrend = sql.raw(`s.source <> 'trend'`);
  const operatorActions = sql.raw(OPERATOR_ACTIONS.map((a) => `'${a}'`).join(", "));
  const postedActions = sql.raw(POSTED_ACTIONS.map((a) => `'${a}'`).join(", "));

  // The day's ops_log lines and desk actions are each read once (ops_log_at_idx, audit_log_type_at_idx)
  const countsQ = sql`WITH o AS (
      SELECT
        count(*) FILTER (WHERE o.message = ${MSG.rendered})::int AS rendered,
        count(*) FILTER (WHERE o.level = 'error' AND o.message LIKE ${`${MSG.renderFailed}%`})::int AS render_failed,
        count(*) FILTER (WHERE o.level = 'error' AND o.message LIKE ${`${MSG.ingestFailed}%`})::int AS ingest_failed
      FROM ops_log o WHERE ${inDay("o.at")}
    ), a AS (
      SELECT
        count(DISTINCT a.entity_id) FILTER (WHERE a.action IN (${operatorActions}))::int AS acted,
        count(DISTINCT a.entity_id) FILTER (WHERE a.action IN (${postedActions}))::int AS approved,
        count(DISTINCT a.entity_id) FILTER (WHERE a.action = 'draft.reject')::int AS rejected
      FROM audit_log a
        JOIN post_drafts d ON d.id = CASE WHEN a.entity_id ~* ${UUID_RE} THEN a.entity_id::uuid END
        JOIN stories s ON s.id = d.story_id
      WHERE a.entity_type = 'post_draft' AND a.action IN (${operatorActions}) AND ${inDay("a.at")} AND ${notTrend}
    )
    SELECT o.rendered, o.render_failed, o.ingest_failed, a.acted, a.approved, a.rejected,
    (SELECT count(*) FROM stories s WHERE ${notTrend} AND ${inDay("s.created_at")})::int AS stories_in,
    (SELECT count(*) FROM stories s WHERE s.source = 'file' AND ${inDay("s.created_at")})::int AS from_share,
    (SELECT count(*) FROM stories s WHERE ${notTrend} AND s.file_id IS NOT NULL AND ${inDay("s.created_at")}
       AND (s.status IN ('converted', 'composed', 'archived') OR (s.status = 'failed' AND s.last_error LIKE ${`${COMPOSE_FAILED_PREFIX}%`})))::int AS converted,
    (SELECT count(*) FROM post_drafts d WHERE d.platform = 'x' AND ${inDay("d.created_at")}
       AND (SELECT s.source FROM stories s WHERE s.id = d.story_id) <> 'trend')::int AS composed,
    (SELECT count(*) FROM stories s WHERE ${notTrend} AND s.status = 'failed' AND ${inDay("s.updated_at")}
       AND coalesce(s.last_error, '') NOT LIKE ${`${COMPOSE_FAILED_PREFIX}%`})::int AS convert_failed,
    (SELECT count(*) FROM stories s WHERE ${notTrend} AND s.status = 'failed' AND ${inDay("s.updated_at")}
       AND s.last_error LIKE ${`${COMPOSE_FAILED_PREFIX}%`})::int AS compose_failed,
    (SELECT count(*) FROM published_posts p JOIN post_drafts d ON d.id = p.draft_id JOIN stories s ON s.id = d.story_id
       WHERE ${notTrend} AND ${inDay("p.published_at")})::int AS posts,
    (SELECT count(*) FROM published_posts p JOIN post_drafts d ON d.id = p.draft_id JOIN stories s ON s.id = d.story_id
       WHERE ${notTrend} AND ${inDay("p.recalled_at")})::int AS recalled,
    (SELECT count(*) FROM publish_jobs j WHERE j.status = 'dead' AND ${inDay("j.updated_at")})::int AS publish_failed
    FROM o, a`;

  const hourlyQ = sql`SELECT h, sum(n_in)::int AS stories_in, sum(n_err)::int AS errors FROM (
      SELECT floor(extract(epoch FROM s.created_at - ${s}) / 3600)::int AS h, 1 AS n_in, 0 AS n_err FROM stories s WHERE ${notTrend} AND ${inDay("s.created_at")}
      UNION ALL
      SELECT floor(extract(epoch FROM o.at - ${s}) / 3600)::int, 0, 1 FROM ops_log o WHERE o.level = 'error' AND ${inDay("o.at")}
    ) x GROUP BY h`;

  // Everything waiting in a stage now: worker stages whatever their day, the desk's queue for the day asked about
  // Each branch matches an index (migration 0032): stories_status_idx, post_drafts_moving_idx, post_drafts_card_due_idx,
  // stories_received_idx. The candidates are few; their rows are then read by primary key.
  const waitingQ = sql`WITH cand AS (
      SELECT s.id FROM stories s WHERE s.status IN ('ingested', 'converted')
      UNION
      SELECT d.story_id FROM post_drafts d WHERE d.platform = 'x' AND d.status IN ('rendering', 'queued', 'publishing')
      UNION
      SELECT d.story_id FROM post_drafts d WHERE d.platform = 'x' AND d.status IN ('ready', 'claimed') AND d.card_rendered_rev < d.card_rev
      UNION
      SELECT s.id FROM stories s
        CROSS JOIN LATERAL (SELECT d.status FROM post_drafts d WHERE d.story_id = s.id AND d.platform = 'x' LIMIT 1) d
        WHERE ${inDay("s.received_at")} AND d.status IN ('ready', 'claimed')
    )
    SELECT ${STORY_COLS} FROM cand c CROSS JOIN LATERAL (SELECT * FROM stories s WHERE s.id = c.id LIMIT 1) s
      LEFT JOIN LATERAL (SELECT * FROM post_drafts d WHERE d.story_id = s.id AND d.platform = 'x' LIMIT 1) d ON true
      WHERE ${notTrend}`;

  const queueQ = sql`SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'dead' AND ${inDay("updated_at")})::int AS failed,
      min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
    FROM publish_jobs`;

  const [countRows, hourRows, waitRows, queueRows, heartbeats, ingest, workerBeat, dataFiles] = await Promise.all([
    rowsOf(db, countsQ),
    rowsOf(db, hourlyQ),
    rowsOf(db, waitingQ),
    rowsOf(db, queueQ),
    readOpsHeartbeats(db),
    readIngestStatus(db),
    readWorkerHeartbeat(db),
    readDataFileStatus(db),
  ]);
  const c = countRows[0] ?? {};
  const n = (k: string) => num(c[k]);

  // Waiting, oldest waiting and stuck per stage, all from one reading of where each story is
  const positions = waitRows.map(storyRow).map((row) => ({ row, pos: storyPosition(row, now) }));
  const waitingIn = (stage: DigitalStage) => positions.filter((p) => p.pos.stage === stage && (p.pos.state === "on_track" || p.pos.state === "stuck"));
  const stageWaiting = (stage: DigitalStage) => {
    // Contract §1.1: ingest and publish report no waiting (publish's queue is under `queues`)
    if (stage === "ingest" || stage === "publish") return { waiting: 0, oldestWaitingAt: null };
    const w = waitingIn(stage);
    const oldest = w.reduce<Date | null>((m, p) => (p.pos.since && (!m || p.pos.since < m) ? p.pos.since : m), null);
    return { waiting: w.length, oldestWaitingAt: oldest?.toISOString() ?? null };
  };
  const phase1 = opts.phase === 1;
  const stageNumbers: Record<DigitalStage, { count: number; failed: number; note: string | null }> = {
    ingest: { count: n("stories_in"), failed: n("ingest_failed"), note: "Files not yet taken in from the share are not tracked here." },
    convert: { count: n("converted"), failed: n("convert_failed"), note: null },
    compose: { count: n("composed"), failed: n("compose_failed"), note: null },
    render: { count: n("rendered"), failed: n("render_failed"), note: phase1 ? "Phase 1: a card is drawn only when someone asks for one." : null },
    operator: { count: n("acted"), failed: 0, note: "Waiting counts the day's desk queue." },
    publish: { count: n("posts"), failed: n("publish_failed"), note: phase1 ? "Phase 1: auto publish is off; posts are copied and marked posted by hand." : null },
  };
  const stages = DIGITAL_STAGES.map((id) => ({ id, count: stageNumbers[id].count, ...stageWaiting(id), failed: stageNumbers[id].failed, note: stageNumbers[id].note }));

  const stuck = positions
    .filter((p) => p.pos.state === "stuck" && p.pos.since)
    .sort((a, b) => a.pos.since!.getTime() - b.pos.since!.getTime())
    .slice(0, STUCK_MAX)
    .map(({ row, pos }) => ({ slug: row.slug, headline: row.headline, stage: pos.stage, since: pos.since!.toISOString(), minutes: pos.minutes! }));

  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const r = hourRows.find((x) => num(x.h) === hour);
    return { hour, storiesIn: num(r?.stories_in), errors: num(r?.errors) };
  });

  const failures = [
    { label: "File could not be taken in", count: n("ingest_failed") },
    { label: "Conversion", count: n("convert_failed") },
    { label: "Compose", count: n("compose_failed") },
    { label: "Card render", count: n("render_failed") },
    { label: "Publish", count: n("publish_failed") },
  ].filter((f) => f.count > 0);

  const q = queueRows[0] ?? {};
  const oldestPending = dateOf(q.oldest_pending);

  // ─── checks (contract §1.3): only what this backend already tracks ───
  const liveness = workerLiveness(ingest, workerBeat, now);
  const share = ingest?.source ?? null;
  const shareState = sourceState(ingest, true, false);
  const brokenFiles = dataFiles.filter((f) => !f.ok);
  const okFileTimes = dataFiles.filter((f) => f.ok).map((f) => Date.parse(f.at)).filter(Number.isFinite);
  const checks = [
    // This answer was read from the database
    { id: "db", label: "Database", ok: true, lastOkAt: now.toISOString(), lastError: null, detail: null },
    {
      id: "share",
      label: "Breaking-news share",
      ok: shareState === "not_polled" ? null : shareState === "ok" || shareState === "folder_missing",
      lastOkAt: ingest?.lastOkAt ?? null,
      // Plain words written for every desk user (no server paths)
      lastError: ingest?.lastError?.message ?? share?.lastError?.message ?? null,
      detail: share ? `${share.filesToday} file${share.filesToday === 1 ? "" : "s"} today; today's folder ${share.todayFolder ? "found" : "not made yet"}` : ingest ? `Source: ${ingest.mode}` : null,
    },
    {
      id: "worker",
      label: "Ingest worker",
      ok: liveness.lastSeenAt === null ? null : !liveness.stopped,
      lastOkAt: liveness.lastSeenAt,
      lastError: liveness.stopped ? "The ingest worker has stopped polling and beating." : null,
      detail: null,
    },
    {
      id: "data-files",
      label: "Data files",
      ok: dataFiles.length === 0 ? null : brokenFiles.length === 0,
      lastOkAt: okFileTimes.length ? new Date(Math.max(...okFileTimes)).toISOString() : null,
      lastError: brokenFiles.length ? brokenFiles.map((f) => `${f.file}: ${f.message ?? "could not be read"}`).join("; ") : null,
      detail: dataFiles.length ? `${dataFiles.length - brokenFiles.length} of ${dataFiles.length} files read` : null,
    },
  ];

  return {
    generatedAt: now.toISOString(),
    date: day.date,
    phase: opts.phase,
    processes: heartbeats.map((h) => ({ process: h.process, system: h.system, host: h.host, startedAt: h.startedAt, beatAt: h.beatAt })),
    checks,
    stages,
    flow: {
      storiesIn: n("stories_in"),
      // Socia's stories come from the breaking-news share (Samvadia's own sources are counted by Samvadia)
      bySource: { portal: 0, outlook: 0, whatsapp: 0, share: n("from_share") },
      approved: n("approved"),
      rejected: n("rejected"),
      inFeed: 0,
      collected: 0,
      medianMinutesToFeed: null,
      posts: n("posts"),
      recalled: n("recalled"),
    },
    hourly,
    stuck,
    failures,
    queues: [
      {
        name: "publish",
        pending: num(q.pending),
        running: num(q.running),
        failed: num(q.failed),
        oldestPendingSec: oldestPending ? Math.max(0, Math.round((now.getTime() - oldestPending.getTime()) / 1000)) : null,
      },
    ],
  };
}

// ─── GET /owner/ops/stories ──────────────────────────────────────────────────

/** For ILIKE: % _ and \ in the search are literal */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

export async function opsStories(db: Db, opts: { q?: string; day?: OpsDay; limit?: number; now?: Date }) {
  const now = opts.now ?? new Date();
  const q = opts.q?.trim();
  const limit = Math.min(Math.max(opts.limit ?? STORIES_DEFAULT_LIMIT, 1), STORIES_MAX_LIMIT);
  const conds: SQL[] = [sql`s.source <> 'trend'`];
  if (q) {
    const p = likePattern(q);
    conds.push(sql`(s.slug ILIKE ${p} ESCAPE '\\' OR s.headline ILIKE ${p} ESCAPE '\\')`);
  }
  if (opts.day) conds.push(sql`s.received_at >= ${ts(opts.day.start)} AND s.received_at < ${ts(opts.day.end)}`);
  const rows = await rowsOf(db, sql`SELECT ${STORY_COLS} FROM ${STORY_FROM} WHERE ${sql.join(conds, sql` AND `)} ORDER BY s.received_at DESC, s.id DESC LIMIT ${limit}`);
  return {
    items: rows.map(storyRow).map((r) => {
      const pos = storyPosition(r, now);
      return { slug: r.slug, headline: r.headline, receivedAt: r.receivedAt.toISOString(), stage: pos.stage, state: pos.state };
    }),
  };
}

// ─── GET /owner/ops/story/{slug} ─────────────────────────────────────────────

const STEP_SYSTEM: Record<DigitalStage, string> = {
  ingest: "socia-ingest",
  convert: "socia-ingest",
  compose: "socia-ingest",
  render: "socia-render",
  operator: "socia-api",
  publish: "socia-api",
};

const OPERATOR_LABEL: Record<string, string> = {
  "draft.copy_posted": "Copied and marked posted",
  "draft.mark_posted": "Marked posted with its link",
  "draft.approve": "Approved for posting",
  "draft.reject": "Rejected",
};

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
/** A stored error as one short line, redacted like a log line (it may carry an exception's text) */
const errorLine = (e: string | null) => (e ? redactText(e).replace(/\s+/g, " ").slice(0, 200) : null);

export async function opsStory(db: Db, slug: string, opts: { phase: 1 | 2; now?: Date }) {
  const now = opts.now ?? new Date();
  // The newest story with this slug (a file saved again after its post went out makes a second story, same slug).
  // org_id IN (orgs) lets the planner use stories_slug_idx (org_id, slug, created_at).
  const [raw] = await rowsOf(
    db,
    sql`SELECT ${STORY_COLS}, s.town, s.district, s.file_tags, s.external, f.file_name, f.bytes, f.ingested_at
      FROM ${STORY_FROM} LEFT JOIN ingested_files f ON f.id = s.file_id
      WHERE s.org_id IN (SELECT id FROM orgs) AND s.slug = ${slug} AND s.source <> 'trend'
      ORDER BY s.created_at DESC LIMIT 1`,
  );
  if (!raw) throw new HttpError(404, "not_found", "There is no story with this slug.");
  const story = storyRow(raw);
  const pos = storyPosition(story, now);

  const ids = [story.id, ...(story.draftId ? [story.draftId] : [])];
  const [actionRows, postRows, logRows] = await Promise.all([
    story.draftId
      ? rowsOf(
          db,
          sql`SELECT action, at FROM audit_log WHERE entity_type = 'post_draft' AND entity_id = ${story.draftId}
            AND action IN (${sql.raw(OPERATOR_ACTIONS.map((a) => `'${a}'`).join(", "))}) ORDER BY at DESC, id DESC LIMIT 1`,
        )
      : Promise.resolve([]),
    story.draftId
      ? rowsOf(db, sql`SELECT published_at, manual, recalled_at FROM published_posts WHERE draft_id = ${story.draftId}::uuid ORDER BY published_at DESC LIMIT 1`)
      : Promise.resolve([]),
    // The worker's own lines about this story (ops_log keeps 14 days), within two days of its arrival
    rowsOf(
      db,
      sql`SELECT message, at FROM ops_log
        WHERE at >= ${ts(new Date(story.createdAt.getTime() - 60_000))} AND at < ${ts(new Date(story.createdAt.getTime() + 2 * 86_400_000))}
          AND item_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND message IN (${sql.join([...MSG.converted, MSG.rendered].map((m) => sql`${m}`), sql`, `)})
        ORDER BY at DESC`,
    ),
  ]);
  const lastLine = (messages: readonly string[]) => isoOf(logRows.find((r) => messages.includes(String(r.message)))?.at);
  const action = actionRows[0];
  const post = postRows[0];

  const fileTags = (raw.file_tags ?? null) as { reporter?: string | null } | null;
  const external = (raw.external ?? null) as { reporter?: string | null } | null;
  const reached = DIGITAL_STAGES.indexOf(pos.stage);
  // Stages after where the story is: never reached when it failed or the desk rejected it, else still to come
  const later: StepState = pos.state === "failed" || (pos.state === "done" && pos.stage === "operator") ? "skipped" : "waiting";
  const stateAt = (i: number): StepState =>
    i < reached ? "done" : i > reached ? later : pos.state === "failed" ? "failed" : pos.state === "done" ? "done" : "waiting";

  const fromFile = story.source === "file";
  const noCard = story.draftId !== null && story.cardRev === 0;
  const steps = DIGITAL_STAGES.map((stage, i) => {
    let state = stateAt(i);
    let label = "";
    let at: string | null = null;
    let detail: string | null = null;
    switch (stage) {
      case "ingest":
        label = fromFile ? "Taken in from the breaking-news share" : story.source === "samvadia" ? "Taken in from Samvadia" : "Taken in";
        state = "done";
        at = isoOf(raw.ingested_at) ?? story.createdAt.toISOString();
        detail = raw.bytes !== null && raw.bytes !== undefined ? `1 file, ${kb(num(raw.bytes))}` : null;
        break;
      case "convert":
        label = "Text read and converted";
        at = state === "done" ? lastLine(MSG.converted) : null;
        if (state === "failed") detail = errorLine(story.lastError);
        break;
      case "compose":
        label = "Post drafted";
        at = isoOf(story.draftCreatedAt);
        if (state === "failed") detail = errorLine(story.lastError);
        break;
      case "render":
        label = "Card drawn";
        // Phase 1 draws a card only on request: none asked for is skipped, not pending
        if (noCard && state !== "failed") {
          state = "skipped";
          detail = "No card was asked for.";
        } else {
          at = story.cardRenderedRev > 0 ? lastLine([MSG.rendered]) : null;
          if (state === "failed") detail = errorLine(story.renderError);
        }
        break;
      case "operator":
        label = action ? (OPERATOR_LABEL[String(action.action)] ?? "Acted on at the desk") : "In the desk queue";
        at = action ? isoOf(action.at) : null;
        if (state === "waiting" && story.draftStatus === "claimed") detail = "Open with an operator.";
        break;
      case "publish":
        label = opts.phase === 1 ? "Marked posted on X" : "Posted on X";
        at = isoOf(post?.published_at);
        if (post?.recalled_at) detail = "Recalled.";
        else if (post) detail = post.manual === true ? "Posted by hand." : null;
        if (state === "failed") detail = "Publishing gave up.";
        break;
    }
    return { stage, label, system: STEP_SYSTEM[stage], state, at, detail };
  });

  return {
    slug: story.slug,
    headline: story.headline,
    reporter: strOf(fileTags?.reporter) ?? strOf(external?.reporter),
    city: strOf(raw.town) ?? strOf(raw.district),
    source: fromFile ? ("share" as const) : null,
    state: pos.state,
    stuckAt: pos.state === "stuck" ? pos.stage : null,
    steps,
  };
}

// ─── GET /owner/ops/logins ───────────────────────────────────────────────────

/**
 * Contract §4 (v1.1): the day's attempts, newest first, at most `max`. When the day has more, every success is kept
 * first (they are few) and the rest are the newest failures; `totals` are the day's true counts and `truncated` says
 * the list was cut.
 */
export async function opsLogins(db: Db, day: OpsDay, max = LOGINS_MAX) {
  const inDay = sql`e.at >= ${ts(day.start)} AND e.at < ${ts(day.end)}`;
  const cols = sql.raw(`e.id AS n, e.id::text AS id, e.at, e.app, e.username, u.name, u.role, e.ip, e.user_agent, e.result`);
  const [events, totalRows, active] = await Promise.all([
    rowsOf(
      db,
      sql`(SELECT ${cols} FROM login_event e LEFT JOIN users u ON u.id = e.user_id
          WHERE ${inDay} AND e.result = 'success' ORDER BY e.at DESC, e.id DESC LIMIT ${max})
        UNION ALL
        (SELECT ${cols} FROM login_event e LEFT JOIN users u ON u.id = e.user_id
          WHERE ${inDay} AND e.result <> 'success' ORDER BY e.at DESC, e.id DESC LIMIT ${max})`,
    ),
    rowsOf(
      db,
      sql`SELECT count(*) FILTER (WHERE e.result = 'success')::int AS success, count(*) FILTER (WHERE e.result <> 'success')::int AS failed
        FROM login_event e WHERE ${inDay}`,
    ),
    // Signed in now: a verified session that has not expired, of a user who may still sign in
    rowsOf(
      db,
      sql`SELECT u.email, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.verified AND s.expires_at > now() AND u.active AND u.deleted_at IS NULL
        ORDER BY s.created_at DESC LIMIT ${ACTIVE_SESSIONS_MAX}`,
    ),
  ]);
  const newestFirst = (a: Row, b: Row) => (dateOf(b.at)?.getTime() ?? 0) - (dateOf(a.at)?.getTime() ?? 0) || num(b.n) - num(a.n);
  const successes = events.filter((r) => r.result === "success").sort(newestFirst).slice(0, max);
  const failures = events.filter((r) => r.result !== "success").sort(newestFirst).slice(0, max - successes.length);
  const kept = [...successes, ...failures].sort(newestFirst);
  const t = totalRows[0] ?? {};
  const totals = { success: num(t.success), failed: num(t.failed) };
  return {
    totals,
    truncated: totals.success + totals.failed > kept.length,
    events: kept.map((r) => ({
      id: String(r.id),
      at: isoOf(r.at),
      app: String(r.app),
      user: String(r.username ?? ""),
      name: strOf(r.name),
      role: strOf(r.role),
      ip: strOf(r.ip),
      userAgent: strOf(r.user_agent)?.slice(0, 200) ?? null,
      result: String(r.result),
    })),
    // Sessions do not record their last request or address: lastSeen and ip are not known here
    activeSessions: active.map((r) => ({ app: "digital-desk", user: String(r.email ?? ""), since: isoOf(r.created_at), lastSeen: null, ip: null })),
  };
}
