// The decision log (reporter-prior brief §2) and the nightly reporter features (§7.1).
//
// Two halves of one row per breaking draft. The worker writes the proposal when it composes the draft; the
// desk's decision (Copy & Posted, Mark posted, Reject, an API post) writes the outcome once. Logging is a
// by-product: every write here runs in its own savepoint, and a failure is caught, reported and dropped, so it
// can never fail or hold up a draft or a desk action.

import { istDayStart } from "@socia/core";
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Executor } from "./client";
import {
  postDecisions, publishedPosts, reporterFeatures,
  type Decision, type ItemOutcome, type LoggedItemOutcome, type LoggedProposal, type ReporterFeatureSet, type VoidedOutcome,
} from "./schema";

/** The tagging logic the proposals came from: b6/b7 tags (v3) plus the reporter prior's first cut */
export const LOGIC_VERSION = "tags-v3+prior-1";

/** One post in ten is an exploration post (brief §7.2.3): its proposals carry explore: true */
export const EXPLORE_RATE = 0.1;

/** The smoothing weight for reporter features (brief §7.1): m pseudo-posts at the desk's overall rate */
export const FEATURE_SMOOTHING_M = 20;

/**
 * Decisions that put the post on X; a rejection says nothing about which tags the desk wanted. An API post
 * ("approved") counts only once it really went out (snapshotReporterFeatures checks published_posts).
 */
export const POSTED_DECISIONS: Decision[] = ["copy_posted", "mark_posted", "approved"];

// ─── Errors never escape ────────────────────────────────────────────────────

export type DecisionLogErrorHandler = (err: unknown, context: Record<string, unknown>) => void;
let onError: DecisionLogErrorHandler = (err, context) => console.error("decision log write failed (the draft is unaffected)", context, err);

/** Where a failed decision-log write is reported (the API passes its logger); the write is dropped either way */
export function setDecisionLogErrorHandler(handler: DecisionLogErrorHandler): void {
  onError = handler;
}

/** Runs `fn` in a savepoint; a failure rolls back only the savepoint and is reported, never thrown */
async function guarded<T>(tx: Executor, context: Record<string, unknown>, fn: (sp: Executor) => Promise<T>): Promise<T | null> {
  try {
    return await tx.transaction(fn);
  } catch (err) {
    try {
      onError(err, context);
    } catch {
      // A broken logger must not turn a dropped log line into a failed desk action
    }
    return null;
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
 * Write the proposal half. A re-saved file that rewrites an undecided draft refreshes it (proposal_rev + 1, the
 * first explore roll kept). A decided row keeps its proposal; it is only marked stale, because the draft it
 * describes was just rewritten (a rejected draft is rewritten in place). Returns whether a proposal was written.
 * Never throws.
 */
export async function recordProposal(tx: Executor, rec: ProposalRecord): Promise<boolean> {
  const done = await guarded(tx, { op: "proposal", draftId: rec.draftId }, async (sp) => {
    const [existing] = await sp
      .select({ explore: postDecisions.explore, decidedAt: postDecisions.decidedAt, stale: postDecisions.proposalStale })
      .from(postDecisions)
      .where(eq(postDecisions.draftId, rec.draftId))
      .for("update");
    if (existing?.decidedAt) {
      if (!existing.stale) await sp.update(postDecisions).set({ proposalStale: true }).where(eq(postDecisions.draftId, rec.draftId));
      return false;
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
        .where(and(eq(postDecisions.draftId, rec.draftId), isNull(postDecisions.decidedAt)));
    } else {
      await sp.insert(postDecisions).values({ orgId: rec.orgId, draftId: rec.draftId, storyId: rec.storyId, ...fields });
    }
    return true;
  });
  return done === true;
}

// ─── The outcome half (API, the desk's decision) ───────────────────────────

export interface OutcomeRecord {
  draftId: string;
  decision: Decision;
  /** The post exactly as it went out (or, for a rejection, as it stood) */
  finalText: string;
  decidedBy: string | null;
  rejectReason?: string | null;
}

/**
 * Write the outcome half, once: a row already decided is left alone (append-only), a draft with no proposal
 * (composed before the log existed, or not a breaking draft) logs nothing. Never throws.
 */
export async function recordOutcome(tx: Executor, rec: OutcomeRecord): Promise<boolean> {
  const done = await guarded(tx, { op: "outcome", draftId: rec.draftId, decision: rec.decision }, async (sp) => {
    const [row] = await sp
      .select({
        id: postDecisions.id, proposals: postDecisions.proposals, draftText: postDecisions.draftText, decidedAt: postDecisions.decidedAt,
        stale: postDecisions.proposalStale,
      })
      .from(postDecisions)
      .where(eq(postDecisions.draftId, rec.draftId))
      .for("update");
    if (!row || row.decidedAt) return false;
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
      .where(and(eq(postDecisions.id, row.id), isNull(postDecisions.decidedAt)))
      .returning({ id: postDecisions.id });
    return !!written;
  });
  return done === true;
}

/**
 * The desk took its decision back (Copy & Posted undone in its window, a rejected draft restored, an API post
 * cancelled): the outcome moves into `voided`, untouched, and the next decision is written fresh. Never throws.
 */
export async function voidOutcome(tx: Executor, draftId: string, voidedBy: string | null): Promise<boolean> {
  const done = await guarded(tx, { op: "void", draftId }, async (sp) => {
    const [row] = await sp.select().from(postDecisions).where(eq(postDecisions.draftId, draftId)).for("update");
    if (!row?.decidedAt || !row.decision) return false;
    const entry: VoidedOutcome = {
      decision: row.decision, decidedAt: row.decidedAt.toISOString(), decidedBy: row.decidedBy, voidedAt: new Date().toISOString(), voidedBy,
      finalText: row.finalText, itemOutcomes: row.itemOutcomes, reworkRatio: row.reworkRatio,
    };
    await sp
      .update(postDecisions)
      .set({
        voided: sql`${postDecisions.voided} || ${JSON.stringify([entry])}::jsonb`,
        decision: null, decidedAt: null, decidedBy: null, rejectReason: null, finalText: null, finalHashtags: null, finalHandles: null,
        itemOutcomes: null, reworkRatio: null,
      })
      .where(eq(postDecisions.id, row.id));
    return true;
  });
  return done === true;
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

/**
 * The file-name values the roster and the code table are missing, most frequent first (brief §2.2): reporter
 * tokens nobody is listed for, tokens two reporters claim, and bureau codes the places file does not carry.
 */
export async function reporterStatusReport(
  db: Executor, orgId: string, opts: { since: Date; until?: Date; limit?: number },
): Promise<StatusReportRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const value = sql<string>`CASE WHEN ${postDecisions.reporterStatus} = 'unknown_bureau_code' THEN ${postDecisions.bureauCode} ELSE ${postDecisions.reporterToken} END`;
  const rows = await db
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
  const out = rows
    .filter((r) => r.value)
    .map((r) => ({ ...r, lastSeen: new Date(r.lastSeen) }) as StatusReportRow)
    .sort((a, b) => b.files - a.files || a.value.localeCompare(b.value));
  // The top `limit` of each status, so a flood of one kind does not hide the others
  const per = new Map<string, number>();
  return out.filter((r) => {
    const n = (per.get(r.status) ?? 0) + 1;
    per.set(r.status, n);
    return n <= limit;
  });
}

// ─── Nightly reporter features (brief §7.1) ────────────────────────────────

/** "2026-11-13": the IST calendar day `at` falls on */
export function istDate(at: Date): string {
  return new Date(istDayStart(at).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

const smooth = (count: number, n: number, base: number, m: number) => (count + m * base) / (n + m);
const round = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Today's snapshot of every reporter's features, from posted decisions made BEFORE today (IST) started (L5): a
 * post decided today never shapes today's numbers. Each rate is smoothed toward the desk's overall rate with m
 * pseudo-posts. Inserts only; a snapshot already taken for the day is kept as it is. Returns the rows written.
 */
export async function snapshotReporterFeatures(db: Executor, orgId: string, now = new Date(), m = FEATURE_SMOOTHING_M): Promise<number> {
  const cutoff = istDayStart(now);
  const snapshotDate = istDate(now);
  const rows = await db
    .select({
      reporter: postDecisions.reporterToken,
      finalHashtags: postDecisions.finalHashtags,
      finalHandles: postDecisions.finalHandles,
      itemOutcomes: postDecisions.itemOutcomes,
      reworkRatio: postDecisions.reworkRatio,
    })
    .from(postDecisions)
    .where(
      and(
        eq(postDecisions.orgId, orgId),
        // A token that names a reporter: an unknown token pools every unattributed file into one profile, a
        // collision mixes two people
        eq(postDecisions.reporterStatus, "matched"),
        isNotNull(postDecisions.reporterToken),
        isNotNull(postDecisions.decidedAt),
        // L5: nothing decided on or after the start of the snapshot's own day
        lt(postDecisions.decidedAt, cutoff),
        inArray(postDecisions.decision, POSTED_DECISIONS),
        // An API post that failed for good or was recalled never reached (or left) X
        sql`(${postDecisions.decision} <> 'approved' OR EXISTS (
          SELECT 1 FROM ${publishedPosts} WHERE ${publishedPosts.draftId} = ${postDecisions.draftId} AND ${publishedPosts.recalledAt} IS NULL
        ))`,
      ),
    );
  if (!rows.length) return 0;

  // The desk's overall rates: the prior every reporter is pulled toward
  const total = rows.length;
  const itemCount = new Map<string, { item: string; kind: "hashtag" | "handle"; count: number }>();
  const sourceCount = new Map<string, { proposed: number; taken: number }>();
  const perReporter = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = perReporter.get(r.reporter!) ?? [];
    list.push(r);
    perReporter.set(r.reporter!, list);
    for (const [kind, items] of [["hashtag", r.finalHashtags ?? []], ["handle", r.finalHandles ?? []]] as const) {
      for (const item of new Set(items.map(itemKey))) {
        const c = itemCount.get(item) ?? { item, kind, count: 0 };
        c.count++;
        itemCount.set(item, c);
      }
    }
    for (const o of r.itemOutcomes ?? []) {
      if (!o.layer) continue;
      const c = sourceCount.get(o.source) ?? { proposed: 0, taken: 0 };
      c.proposed++;
      if (o.outcome === "kept" || o.outcome === "accepted") c.taken++;
      sourceCount.set(o.source, c);
    }
  }

  const values = [...perReporter].map(([reporter, list]) => {
    const n = list.length;
    const items: ReporterFeatureSet["items"] = {};
    const counts = new Map<string, number>();
    for (const r of list) {
      for (const item of new Set([...(r.finalHashtags ?? []), ...(r.finalHandles ?? [])].map(itemKey))) counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    for (const [item, count] of counts) {
      const all = itemCount.get(item)!;
      const base = all.count / total;
      items[item] = { kind: all.kind, count, rate: round(count / n), smoothed: round(smooth(count, n, base, m)), base: round(base) };
    }
    const sources: ReporterFeatureSet["sources"] = {};
    const own = new Map<string, { proposed: number; taken: number }>();
    for (const r of list) {
      for (const o of r.itemOutcomes ?? []) {
        if (!o.layer) continue;
        const c = own.get(o.source) ?? { proposed: 0, taken: 0 };
        c.proposed++;
        if (o.outcome === "kept" || o.outcome === "accepted") c.taken++;
        own.set(o.source, c);
      }
    }
    for (const [source, c] of own) {
      const all = sourceCount.get(source)!;
      const base = all.taken / all.proposed;
      sources[source] = { proposed: c.proposed, taken: c.taken, rate: round(c.taken / c.proposed), smoothed: round(smooth(c.taken, c.proposed, base, m)), base: round(base) };
    }
    const reworks = list.map((r) => r.reworkRatio).filter((x): x is number => typeof x === "number");
    const features: ReporterFeatureSet = {
      m, cutoff: cutoff.toISOString(), items, sources,
      reworkMean: reworks.length ? round(reworks.reduce((a, b) => a + b, 0) / reworks.length) : null,
    };
    return { orgId, snapshotDate, reporter, n, features };
  });

  let written = 0;
  for (let i = 0; i < values.length; i += 200) {
    const out = await db.insert(reporterFeatures).values(values.slice(i, i + 200)).onConflictDoNothing().returning({ reporter: reporterFeatures.reporter });
    written += out.length;
  }
  return written;
}
