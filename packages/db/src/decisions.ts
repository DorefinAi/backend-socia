// The decision log (reporter-prior brief §2) and the nightly reporter features (§7.1).
//
// Two halves of one row per breaking draft. The worker writes the proposal when it composes the draft; the
// desk's decision (Copy & Posted, Mark posted, Reject; an API post when it really went out) writes the outcome
// once. Logging is a by-product: every write here runs in its own savepoint with a short lock timeout, and a
// failure is caught, reported and dropped, so it can never fail or hold up a draft or a desk action.

import { istDayStart } from "@socia/core";
import { and, count, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Db, Executor } from "./client";
import * as schema from "./schema";
import {
  postDecisions, postDrafts, reporterFeatures, stories,
  type Decision, type ItemOutcome, type LoggedItemOutcome, type LoggedProposal, type ReporterFeatureSet,
} from "./schema";

/** The tagging logic the proposals came from: b6/b7 tags (v3) plus the reporter prior's first cut */
export const LOGIC_VERSION = "tags-v3+prior-1";

/** One post in ten is an exploration post (brief §7.2.3): its proposals carry explore: true */
export const EXPLORE_RATE = 0.1;

/** The smoothing weight for reporter features (brief §7.1): m pseudo-posts at the desk's overall rate */
export const FEATURE_SMOOTHING_M = 20;
/** The features' rolling window, before the start of the snapshot's day */
export const FEATURE_WINDOW_DAYS = 90;
/** At most this many items per reporter, by count */
export const FEATURE_MAX_ITEMS = 200;
/** Snapshots older than this are deleted */
export const FEATURE_RETENTION_DAYS = 90;

/** How long a log write waits for a row lock before it gives up (a desk click never waits on the log) */
export const LOG_LOCK_TIMEOUT = "500ms";

/**
 * Decisions that put the post on X; a rejection says nothing about which tags the desk wanted. An API post is
 * logged as "approved" only when the publish worker has posted it (queue.ts completePost).
 */
export const POSTED_DECISIONS: Decision[] = ["copy_posted", "mark_posted", "approved"];

// ─── Errors never escape ────────────────────────────────────────────────────

/** pino-compatible */
export interface DecisionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const consoleLogger: DecisionLogger = {
  info: () => {},
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};
let logger: DecisionLogger = consoleLogger;

/** Where the decision log reports what it could not write (the API and the worker pass their pino logger) */
export function setDecisionLogger(next: DecisionLogger): void {
  logger = next;
}

/** Logs, and falls back to the console when the logger itself throws: a log line never fails a desk action */
export function decisionLog(level: keyof DecisionLogger, obj: Record<string, unknown>, msg: string): void {
  try {
    logger[level](obj, msg);
  } catch (err) {
    try {
      console.error(`decision log: the logger failed (${msg})`, obj, err);
    } catch {
      // nothing left to tell
    }
  }
}

/**
 * What a log write did:
 * - written: the row was written;
 * - no_row: there is no proposal for the draft (composed before the log, or not a breaking draft);
 * - already_decided: a decided row was left as it is (the same decision again, or a re-save marked it stale);
 * - not_decided: a void found nothing to void;
 * - failed: the write failed, was rolled back to its savepoint and logged at error. The caller went on.
 */
export type LogStatus = "written" | "no_row" | "already_decided" | "not_decided" | "failed";

/**
 * Runs `fn` in a savepoint with a short lock timeout (restored afterwards; a failed savepoint rolls it back with
 * everything else). A failure rolls back only the savepoint, is logged at error, and is returned as "failed".
 */
async function guarded(tx: Executor, context: Record<string, unknown>, fn: (sp: Executor) => Promise<LogStatus>): Promise<LogStatus> {
  try {
    return await tx.transaction(async (sp) => {
      const set = await sp.execute(sql`SELECT current_setting('lock_timeout') AS prev, set_config('lock_timeout', ${LOG_LOCK_TIMEOUT}, true)`);
      const prev = String((set.rows[0] as { prev?: unknown } | undefined)?.prev ?? "0");
      const status = await fn(sp);
      await sp.execute(sql`SELECT set_config('lock_timeout', ${prev}, true)`);
      return status;
    });
  } catch (err) {
    decisionLog("error", { err, ...context }, "decision log write failed and was dropped; the draft or desk action went through");
    return "failed";
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

const TAG_OR_MENTION = /[#@][\p{L}\p{M}\p{N}_]+/gu;
const URL_RE = /\bhttps?:\/\/\S+|\b(?:www\.)?[a-z0-9-]+\.(?:com|in|org|net|co|ly|me)\/\S*/giu;

/** An item's comparison key: "#jaipur", "@rajgovofficial" */
export const itemKey = (item: string) => item.normalize("NFC").trim().toLowerCase();

/** The hashtags and handles in a post, in order, first spelling of each */
export function postItems(text: string): { hashtags: string[]; handles: string[] } {
  const hashtags = new Map<string, string>();
  const handles = new Map<string, string>();
  for (const m of text.normalize("NFC").matchAll(TAG_OR_MENTION)) {
    const target = m[0].startsWith("#") ? hashtags : handles;
    if (!target.has(itemKey(m[0]))) target.set(itemKey(m[0]), m[0]);
  }
  return { hashtags: [...hashtags.values()], handles: [...handles.values()] };
}

/** The words of a post: hashtags, handles and links out, spaces collapsed (brief §2.5) */
export function reworkBase(text: string): string {
  return text.normalize("NFC").replace(URL_RE, " ").replace(TAG_OR_MENTION, " ").replace(/\s+/gu, " ").trim();
}

/** Levenshtein distance over code points (Devanagari matras count as one edit each) */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/**
 * How much the desk rewrote the words (brief §2.5): the edit distance between the draft and the final post with
 * hashtags, handles and links stripped, over the stripped draft's length. 0 = posted as drafted. Null when the
 * draft had no words of its own to compare.
 */
export function reworkRatio(draftText: string, finalText: string): number | null {
  const before = reworkBase(draftText);
  if (!before) return null;
  return editDistance(before, reworkBase(finalText)) / Array.from(before).length;
}

/**
 * Each proposed item's fate in the final post (brief §2.4): an emitted item was kept or removed, a suggested one
 * accepted or ignored; an item in the post that no rule proposed is desk_added. An item proposed twice counts
 * once, the emitted layer first.
 */
export function itemOutcomes(proposals: readonly LoggedProposal[], finalText: string): LoggedItemOutcome[] {
  const final = postItems(finalText);
  const inFinal = new Set([...final.hashtags, ...final.handles].map(itemKey));
  const ordered = [...proposals.filter((p) => p.layer === "emit"), ...proposals.filter((p) => p.layer !== "emit")];
  const seen = new Set<string>();
  const out: LoggedItemOutcome[] = [];
  for (const p of ordered) {
    const key = itemKey(p.item);
    if (seen.has(key)) continue;
    seen.add(key);
    const present = inFinal.has(key);
    const outcome: ItemOutcome = p.layer === "emit" ? (present ? "kept" : "removed") : present ? "accepted" : "ignored";
    out.push({ item: p.item, kind: p.kind, layer: p.layer, source: p.source, outcome });
  }
  for (const [kind, items] of [["hashtag", final.hashtags], ["handle", final.handles]] as const) {
    for (const item of items) {
      if (seen.has(itemKey(item))) continue;
      seen.add(itemKey(item));
      out.push({ item, kind, layer: null, source: "desk", outcome: "desk_added" });
    }
  }
  return out;
}

/** Proposals as stored: the explore flag set on every item of an exploration post */
export function withExplore(proposals: readonly LoggedProposal[], explore: boolean): LoggedProposal[] {
  return proposals.map((p) => {
    const { explore: _drop, ...rest } = p;
    return explore ? { ...rest, explore: true } : rest;
  });
}

// ─── The proposal half (worker, compose) ───────────────────────────────────

export interface ProposalRecord {
  orgId: string;
  draftId: string;
  storyId: string;
  filenameRaw: string | null;
  slotRaw: string | null;
  reporterToken: string | null;
  bureauCode: string | null;
  bureauDistrict: string | null;
  reporterHandle: string | null;
  reporterStatus: string;
  storyClass: string | null;
  district: string | null;
  districtFrom: string | null;
  composeVersion: string;
  draftText: string;
  proposals: LoggedProposal[];
  /** Whether this post explores; ignored when a re-saved file rewrites a draft (its first roll stands) */
  explore: boolean;
  logicVersion?: string;
}

/**
 * Write the proposal half. `build` runs INSIDE the savepoint, so anything it reads or works out (the file name,
 * the reporter status, the proposals) can fail without touching the caller's transaction.
 *
 * A re-saved file that rewrites an undecided draft refreshes the row (proposal_rev + 1, the first explore roll
 * kept). A decided row keeps its proposal and is only marked stale, because the draft it describes was just
 * rewritten (a rejected draft is rewritten in place): "already_decided". Never throws.
 */
export async function recordProposal(
  tx: Executor,
  ctx: { orgId: string; draftId: string },
  build: ProposalRecord | ((sp: Executor) => ProposalRecord | Promise<ProposalRecord>),
): Promise<LogStatus> {
  return guarded(tx, { op: "proposal", ...ctx }, async (sp) => {
    const rec = typeof build === "function" ? await build(sp) : build;
    const [existing] = await sp
      .select({ explore: postDecisions.explore, decidedAt: postDecisions.decidedAt, stale: postDecisions.proposalStale })
      .from(postDecisions)
      .where(eq(postDecisions.draftId, rec.draftId))
      .for("update");
    if (existing?.decidedAt) {
      if (!existing.stale) {
        await sp.update(postDecisions).set({ proposalStale: true }).where(eq(postDecisions.draftId, rec.draftId));
        decisionLog("info", { ...ctx }, "decision log: the draft was rewritten after the desk decided; its proposal is marked stale");
      }
      return "already_decided";
    }
    const explore = existing ? existing.explore : rec.explore;
    const fields = {
      filenameRaw: rec.filenameRaw, slotRaw: rec.slotRaw, reporterToken: rec.reporterToken, bureauCode: rec.bureauCode,
      bureauDistrict: rec.bureauDistrict, reporterHandle: rec.reporterHandle, reporterStatus: rec.reporterStatus, storyClass: rec.storyClass,
      district: rec.district, districtFrom: rec.districtFrom, logicVersion: rec.logicVersion ?? LOGIC_VERSION, composeVersion: rec.composeVersion,
      draftText: rec.draftText, proposals: withExplore(rec.proposals, explore), explore, proposalStale: false,
    };
    if (existing) {
      await sp
        .update(postDecisions)
        .set({ ...fields, proposedAt: sql`now()`, proposalRev: sql`${postDecisions.proposalRev} + 1` })
        .where(eq(postDecisions.draftId, rec.draftId));
    } else {
      await sp.insert(postDecisions).values({ orgId: rec.orgId, draftId: rec.draftId, storyId: rec.storyId, ...fields });
    }
    return "written";
  });
}

// ─── Voiding ────────────────────────────────────────────────────────────────

/**
 * The outcome as it stands, built by the database: the trigger compares voided[-1] with exactly this, so a void
 * can neither drop nor forge any part of it.
 */
const OUTCOME_SNAPSHOT = sql`jsonb_build_object(
  'decision', ${postDecisions.decision}, 'decided_at', ${postDecisions.decidedAt}, 'decided_by', ${postDecisions.decidedBy},
  'reject_reason', ${postDecisions.rejectReason}, 'final_text', ${postDecisions.finalText}, 'final_hashtags', ${postDecisions.finalHashtags},
  'final_handles', ${postDecisions.finalHandles}, 'item_outcomes', ${postDecisions.itemOutcomes}, 'rework_ratio', ${postDecisions.reworkRatio})`;
const PROPOSAL_SNAPSHOT = sql`jsonb_build_object(
  'proposals', ${postDecisions.proposals}, 'draft_text', ${postDecisions.draftText}, 'proposal_rev', ${postDecisions.proposalRev},
  'proposal_stale', ${postDecisions.proposalStale})`;

/** Moves a decided row's outcome into `voided` (with the proposal it was measured against) and clears it */
async function voidRow(sp: Executor, where: SQL, voidedBy: string | null, late: boolean): Promise<boolean> {
  const out = await sp
    .update(postDecisions)
    .set({
      voided: sql`${postDecisions.voided} || jsonb_build_array(jsonb_build_object(
        'outcome', ${OUTCOME_SNAPSHOT}, 'proposal', ${PROPOSAL_SNAPSHOT},
        'voided_at', now(), 'voided_by', ${voidedBy}::uuid, 'late', ${late}::boolean))`,
      decision: null, decidedAt: null, decidedBy: null, rejectReason: null, finalText: null, finalHashtags: null, finalHandles: null,
      itemOutcomes: null, reworkRatio: null,
    })
    .where(and(where, isNotNull(postDecisions.decidedAt)))
    .returning({ id: postDecisions.id });
  return out.length > 0;
}

/**
 * The desk took its decision back (Copy & Posted undone in its window, a rejected draft restored): the outcome
 * moves into `voided`, whole, and the next decision is written fresh. Never throws.
 */
export async function voidOutcome(tx: Executor, rec: { orgId: string; draftId: string; voidedBy: string | null }): Promise<LogStatus> {
  return guarded(tx, { op: "void", orgId: rec.orgId, draftId: rec.draftId }, async (sp) => {
    const [row] = await sp
      .select({ id: postDecisions.id, decidedAt: postDecisions.decidedAt })
      .from(postDecisions)
      .where(eq(postDecisions.draftId, rec.draftId))
      .for("update");
    if (!row) return "no_row";
    if (!row.decidedAt) return "not_decided";
    return (await voidRow(sp, eq(postDecisions.id, row.id), rec.voidedBy, false)) ? "written" : "not_decided";
  });
}

// ─── The outcome half (the desk's decision) ────────────────────────────────

export interface OutcomeRecord {
  orgId: string;
  draftId: string;
  decision: Decision;
  /** The post exactly as it went out (or, for a rejection, as it stood) */
  finalText: string;
  decidedBy: string | null;
  rejectReason?: string | null;
}

/**
 * Write the outcome half, once. A draft with no proposal logs nothing ("no_row").
 *
 * A row already decided means one of two things. The same decision with the same text is a repeat and is left
 * alone ("already_decided"). Anything else can only follow an undo or a restore whose void failed — the desk's
 * state machine allows no second decision otherwise — so the withdrawn decision is voided now (marked `late`)
 * and the new one written, rather than keeping a decision the desk took back. Never throws.
 */
export async function recordOutcome(tx: Executor, rec: OutcomeRecord): Promise<LogStatus> {
  return guarded(tx, { op: "outcome", orgId: rec.orgId, draftId: rec.draftId, decision: rec.decision }, async (sp) => {
    const [row] = await sp
      .select({
        id: postDecisions.id, proposals: postDecisions.proposals, draftText: postDecisions.draftText, decidedAt: postDecisions.decidedAt,
        decision: postDecisions.decision, finalText: postDecisions.finalText, stale: postDecisions.proposalStale,
      })
      .from(postDecisions)
      .where(eq(postDecisions.draftId, rec.draftId))
      .for("update");
    if (!row) return "no_row";
    if (row.decidedAt) {
      if (row.decision === rec.decision && row.finalText === rec.finalText) return "already_decided";
      await voidRow(sp, eq(postDecisions.id, row.id), rec.decidedBy, true);
      decisionLog("warn", { orgId: rec.orgId, draftId: rec.draftId, withdrawn: row.decision, decision: rec.decision },
        "decision log: a withdrawn decision was still in place (its void had failed); voided it now, late");
    }
    const items = postItems(rec.finalText);
    const proposals = Array.isArray(row.proposals) ? row.proposals : [];
    const [written] = await sp
      .update(postDecisions)
      .set({
        decision: rec.decision,
        decidedAt: sql`now()`,
        decidedBy: rec.decidedBy,
        rejectReason: rec.rejectReason ?? null,
        finalText: rec.finalText,
        finalHashtags: items.hashtags,
        finalHandles: items.handles,
        // Against a stale proposal these would measure the re-save, not the desk: the final post alone is kept
        itemOutcomes: row.stale ? null : itemOutcomes(proposals, rec.finalText),
        reworkRatio: row.stale ? null : reworkRatio(row.draftText, rec.finalText),
      })
      .where(eq(postDecisions.id, row.id))
      .returning({ id: postDecisions.id });
    return written ? "written" : "failed";
  });
}

/**
 * For the desk's callers: a failed write is already logged at error; a missing row is worth a warning only on a
 * draft that should have one (a breaking draft: it has a handle_pick).
 */
export function noteOutcome(status: LogStatus, ctx: { orgId: string; draftId: string; op: string; expectRow: boolean }): void {
  const { expectRow, ...rest } = ctx;
  if (status === "failed") decisionLog("warn", rest, "decision log: this desk action was not logged (the write failed)");
  else if (status === "no_row" && expectRow) decisionLog("warn", rest, "decision log: a breaking draft with no proposal row; this desk action was not logged");
}

// ─── The weekly reporter-status report ─────────────────────────────────────

export interface StatusReportRow {
  status: "unknown_token" | "collision" | "unknown_bureau_code";
  /** The reporter token, or the bureau code for unknown_bureau_code */
  value: string;
  files: number;
  lastSeen: Date;
  /** One file name that carried it */
  example: string | null;
}

export interface StatusReport {
  rows: StatusReportRow[];
  /** Rows of these statuses with no token or code to report (left out) */
  dropped: number;
  /** Breaking drafts created in the window, and how many of them have a decision-log row */
  coverage: { breakingDrafts: number; logged: number };
}

/**
 * The file-name values the roster and the code table are missing, most frequent first (brief §2.2): reporter
 * tokens nobody is listed for, tokens two reporters claim, and bureau codes the places file does not carry. With
 * the log's coverage of the window's breaking drafts, so a gap in the log is not read as a clean week.
 */
export async function reporterStatusReport(db: Executor, orgId: string, opts: { since: Date; until?: Date; limit?: number }): Promise<StatusReport> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const value = sql<string | null>`CASE WHEN ${postDecisions.reporterStatus} = 'unknown_bureau_code' THEN ${postDecisions.bureauCode} ELSE ${postDecisions.reporterToken} END`;
  const grouped = await db
    .select({
      status: postDecisions.reporterStatus,
      value,
      files: sql<number>`count(*)::int`,
      lastSeen: sql<Date>`max(${postDecisions.proposedAt})`,
      example: sql<string | null>`(array_agg(${postDecisions.filenameRaw} ORDER BY ${postDecisions.proposedAt} DESC))[1]`,
    })
    .from(postDecisions)
    .where(
      and(
        eq(postDecisions.orgId, orgId),
        inArray(postDecisions.reporterStatus, ["unknown_token", "collision", "unknown_bureau_code"]),
        gte(postDecisions.proposedAt, opts.since),
        // No upper bound unless asked: the database's clock, not this process's, stamped proposed_at
        opts.until ? lt(postDecisions.proposedAt, opts.until) : undefined,
      ),
    )
    .groupBy(postDecisions.reporterStatus, value);
  const dropped = grouped.filter((r) => !r.value).reduce((n, r) => n + r.files, 0);
  const sorted = grouped
    .filter((r) => r.value)
    .map((r) => ({ ...r, value: r.value!, lastSeen: new Date(r.lastSeen) }) as StatusReportRow)
    .sort((a, b) => b.files - a.files || a.value.localeCompare(b.value));
  // The top `limit` of each status, so a flood of one kind does not hide the others
  const per = new Map<string, number>();
  const rows = sorted.filter((r) => {
    const n = (per.get(r.status) ?? 0) + 1;
    per.set(r.status, n);
    return n <= limit;
  });

  const [cov] = await db
    .select({ breakingDrafts: count(), logged: count(postDecisions.id) })
    .from(postDrafts)
    .innerJoin(stories, eq(stories.id, postDrafts.storyId))
    .leftJoin(postDecisions, eq(postDecisions.draftId, postDrafts.id))
    .where(
      and(
        eq(postDrafts.orgId, orgId),
        eq(stories.layout, "breaking"),
        gte(postDrafts.createdAt, opts.since),
        opts.until ? lt(postDrafts.createdAt, opts.until) : undefined,
      ),
    );
  return { rows, dropped, coverage: { breakingDrafts: cov?.breakingDrafts ?? 0, logged: cov?.logged ?? 0 } };
}

// ─── Nightly reporter features (brief §7.1) ────────────────────────────────

/** "2026-11-13": the IST calendar day `at` falls on */
export function istDate(at: Date): string {
  return new Date(istDayStart(at).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** "2026-11-13" minus `days` days */
export function minusDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - days)).toISOString().slice(0, 10);
}

const smooth = (count: number, n: number, base: number, m: number) => (count + m * base) / (n + m);
const round = (x: number) => Math.round(x * 10_000) / 10_000;

export interface FeatureSnapshot {
  day: string;
  /** Rows this run inserted */
  written: number;
  /** Reporters with a snapshot for the day, by count(*) (this run's and any earlier run's) */
  reporters: number;
  /** Snapshots deleted for being older than FEATURE_RETENTION_DAYS */
  pruned: number;
}

/** Tests only: lets a test act between the snapshot's reads (another connection commits a decision, say) */
export interface SnapshotHooks {
  /** After the reporters are counted, before their items and sources are read */
  betweenReads?: () => Promise<void>;
}

/**
 * Today's snapshot of every matched reporter's features, keyed by handle.
 *
 * Only posted decisions of matched reporters made in the FEATURE_WINDOW_DAYS before today (IST) began (L5: a
 * post decided today never shapes today's numbers). Each rate is smoothed toward the desk's overall rate with m
 * pseudo-posts; at most FEATURE_MAX_ITEMS items per reporter. The counting is done in SQL.
 *
 * L6 (out-of-fold target encoding) applies to an offline evaluation of these features; none exists yet, so
 * nothing here needs it.
 *
 * One REPEATABLE READ transaction, so every query sees the same rows, under a per-org advisory lock taken on the
 * same connection BEFORE the transaction starts: a second run waits for the first to commit and then sees its rows
 * (a lock taken inside the transaction would come after its snapshot, and the second run's inserts would hit
 * rows it cannot see). Inserts only (a snapshot already taken is kept); snapshots older than the retention go.
 */
export async function snapshotReporterFeatures(
  pool: pg.Pool, orgId: string, now = new Date(), m = FEATURE_SMOOTHING_M, hooks: SnapshotHooks = {},
): Promise<FeatureSnapshot> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("SET statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock(hashtext('socia.reporter_features'), hashtext($1))", [orgId]);
    try {
      return await snapshotOn(drizzle(client, { schema }), orgId, now, m, hooks);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('socia.reporter_features'), hashtext($1))", [orgId]);
    }
  } catch (err) {
    // A connection left holding a lock or a setting is closed rather than returned to the pool
    broken = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    if (!broken) await client.query("RESET statement_timeout").catch((e: unknown) => void (broken = e as Error));
    client.release(broken);
  }
}

async function snapshotOn(db: Pick<Db, "transaction">, orgId: string, now: Date, m: number, hooks: SnapshotHooks): Promise<FeatureSnapshot> {
  const cutoff = istDayStart(now);
  const since = new Date(cutoff.getTime() - FEATURE_WINDOW_DAYS * 86_400_000);
  const day = istDate(now);
  return db.transaction(
    async (tx) => {
      const base = sql`
        SELECT d.id, lower(ltrim(d.reporter_handle, '@')) AS r, d.final_hashtags, d.final_handles, d.item_outcomes, d.rework_ratio
          FROM post_decisions d
         WHERE d.org_id = ${orgId} AND d.reporter_status = 'matched' AND d.reporter_handle IS NOT NULL
           AND d.decided_at IS NOT NULL AND d.decided_at >= ${since.toISOString()}::timestamptz AND d.decided_at < ${cutoff.toISOString()}::timestamptz
           AND d.decision IN ('copy_posted', 'mark_posted', 'approved')
           -- An API post that was recalled no longer stands
           AND (d.decision <> 'approved' OR EXISTS (SELECT 1 FROM published_posts p WHERE p.draft_id = d.draft_id AND p.recalled_at IS NULL))`;

      const reporters = (await tx.execute(sql`
        WITH base AS (${base})
        SELECT r, count(*)::int AS n, avg(rework_ratio)::float8 AS rework FROM base GROUP BY r`)).rows as { r: string; n: number; rework: number | null }[];
      const total = reporters.reduce((a, r) => a + r.n, 0);
      if (!total) return { day, written: 0, ...(await finish(tx, orgId, day)) };
      await hooks.betweenReads?.();

      // An item's key as itemKey() makes it: NFC and lower case, so "#क़ानून" stored precomposed and decomposed
      // count as one item. normalize() needs PostgreSQL 13+ on a UTF8 database; anywhere else lower() alone
      // (the outcome writes already store NFC: postItems normalizes the final text).
      const nfc = ((await tx.execute(sql`
        SELECT current_setting('server_version_num')::int >= 130000 AND current_setting('server_encoding') = 'UTF8' AS ok`)).rows[0] as { ok?: boolean } | undefined)?.ok === true;
      const key = nfc ? sql`lower(normalize(i, NFC))` : sql`lower(i)`;
      const items = (await tx.execute(sql`
        WITH base AS (${base}),
        items AS (
          SELECT DISTINCT b.id, b.r, ${key} AS k
            FROM base b CROSS JOIN LATERAL unnest(coalesce(b.final_hashtags, '{}'::text[]) || coalesce(b.final_handles, '{}'::text[])) AS i
        ),
        tot AS (SELECT k, count(*)::int AS all_c FROM items GROUP BY k),
        per AS (SELECT r, k, count(*)::int AS c FROM items GROUP BY r, k),
        ranked AS (
          SELECT per.r, per.k, per.c, tot.all_c,
                 row_number() OVER (PARTITION BY per.r ORDER BY per.c DESC, per.k) AS rn,
                 count(*) OVER (PARTITION BY per.r)::int AS distinct_items
            FROM per JOIN tot USING (k)
        )
        SELECT r, k, c, all_c, distinct_items FROM ranked WHERE rn <= ${FEATURE_MAX_ITEMS}`)).rows as
        { r: string; k: string; c: number; all_c: number; distinct_items: number }[];

      const sources = (await tx.execute(sql`
        WITH base AS (${base}),
        outs AS (
          SELECT b.r, o->>'source' AS s, (o->>'outcome') IN ('kept', 'accepted') AS taken
            FROM base b
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b.item_outcomes) = 'array' THEN b.item_outcomes ELSE '[]'::jsonb END) AS o
           WHERE o->>'layer' IS NOT NULL AND o->>'source' IS NOT NULL
        ),
        per AS (SELECT r, s, count(*)::int AS proposed, (count(*) FILTER (WHERE taken))::int AS taken FROM outs GROUP BY r, s)
        SELECT r, s, proposed, taken,
               (sum(proposed) OVER (PARTITION BY s))::int AS all_p, (sum(taken) OVER (PARTITION BY s))::int AS all_t
          FROM per`)).rows as { r: string; s: string; proposed: number; taken: number; all_p: number; all_t: number }[];

      const values = reporters.map(({ r, n, rework }) => {
        const mine = items.filter((i) => i.r === r);
        const features: ReporterFeatureSet = {
          m, cutoff: cutoff.toISOString(), since: since.toISOString(),
          itemsDropped: Math.max(0, (mine[0]?.distinct_items ?? 0) - FEATURE_MAX_ITEMS),
          items: {}, sources: {}, reworkMean: rework === null ? null : round(rework),
        };
        for (const i of mine) {
          const baseRate = i.all_c / total;
          features.items[i.k] = { kind: i.k.startsWith("#") ? "hashtag" : "handle", count: i.c, rate: round(i.c / n), smoothed: round(smooth(i.c, n, baseRate, m)), base: round(baseRate) };
        }
        for (const s of sources.filter((x) => x.r === r)) {
          const baseRate = s.all_t / s.all_p;
          features.sources[s.s] = { proposed: s.proposed, taken: s.taken, rate: round(s.taken / s.proposed), smoothed: round(smooth(s.taken, s.proposed, baseRate, m)), base: round(baseRate) };
        }
        return { orgId, snapshotDate: day, reporter: r, n, features };
      });

      let written = 0;
      for (let i = 0; i < values.length; i += 200) {
        const out = await tx.insert(reporterFeatures).values(values.slice(i, i + 200)).onConflictDoNothing().returning({ reporter: reporterFeatures.reporter });
        written += out.length;
      }
      return { day, written, ...(await finish(tx, orgId, day)) };
    },
    { isolationLevel: "repeatable read" },
  );
}

/** Retention, and the day's reporter count as stored */
async function finish(tx: Executor, orgId: string, day: string): Promise<{ reporters: number; pruned: number }> {
  const pruned = await tx
    .delete(reporterFeatures)
    .where(and(eq(reporterFeatures.orgId, orgId), lt(reporterFeatures.snapshotDate, minusDays(day, FEATURE_RETENTION_DAYS))))
    .returning({ reporter: reporterFeatures.reporter });
  const [c] = await tx.select({ n: count() }).from(reporterFeatures).where(and(eq(reporterFeatures.orgId, orgId), eq(reporterFeatures.snapshotDate, day)));
  return { reporters: c?.n ?? 0, pruned: pruned.length };
}
