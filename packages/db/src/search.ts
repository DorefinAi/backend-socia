// Story search (GET /search/stories). story_search holds each story's folded text and phonetic key (core
// search.ts); the worker's sweep keeps it current, and searchStories matches query words against it with LIKE.
// Both sides are already lower-cased by fold / phoneticKey, so LIKE gives exactly what ILIKE would, without
// ILIKE's per-row case folding (3-5x faster than ILIKE on Hindi bodies; that is LIKE vs ILIKE, not index use).
// The trigram indexes serve both. Matching and ranking are SQL: nothing is scanned in JS.

import { fold, phoneticKey, searchField, searchPattern, wholeWordPattern, type SearchWord } from "@socia/core";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "./client";
import { storySearch } from "./schema";

// ---- The sweep ------------------------------------------------------------------------------------------------

/** Stories per sweep batch */
export const SEARCH_SWEEP_BATCH = 500;
/** The steady-state sweep looks only at stories edited this recently (stories_updated_idx) */
export const SEARCH_SWEEP_RECENT_MINUTES = 15;
/** pg_try_advisory_xact_lock key: one sweep at a time across every worker */
export const SEARCH_SWEEP_LOCK = 7_302_025;

export interface SearchSweepLog {
  warn: (obj: object, msg: string) => void;
}

export interface SearchSweepResult {
  /** Stories that needed a row (= batch: there may be more) */
  candidates: number;
  /** Rows written */
  written: number;
  /** Stories whose row could not be written (logged; tried again on the next sweep that sees them) */
  skipped: number;
  /** Another sweep held the lock: nothing was done */
  locked: boolean;
}

interface SweepRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  headline: string | null;
  body: string | null;
  town: string | null;
  district: string | null;
  /** As text: a JS Date drops the microseconds, and the row would never compare equal again */
  updated_at: string;
  created_at: string;
}

/**
 * Builds or refreshes the search rows of up to `batch` stories: those with no row, or edited after their row was
 * built (stories.updated_at newer than source_updated_at). `sinceMinutes` limits it to stories edited that
 * recently (the worker's steady-state tick); without it every story is checked (worker start, hourly, backfill).
 * One sweep at a time (an advisory lock; when it is taken nothing is done). Rows go in sorted by story id, as one
 * insert; if that fails, one by one, and a row that still fails is logged and skipped so it cannot block the rest.
 */
export async function syncStorySearch(
  db: Db,
  opts: { batch?: number; sinceMinutes?: number; log?: SearchSweepLog } = {},
): Promise<SearchSweepResult> {
  const batch = opts.batch ?? SEARCH_SWEEP_BATCH;
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${SEARCH_SWEEP_LOCK}) AS got`);
    if (!lock.rows[0]?.got) return { candidates: 0, written: 0, skipped: 0, locked: true };

    const recent = opts.sinceMinutes === undefined ? sql`` : sql`s.updated_at > now() - make_interval(mins => ${opts.sinceMinutes}) AND`;
    // The ids first (narrow), then the wide columns of just those stories
    const { rows } = await tx.execute<SweepRow>(sql`
      WITH cand AS (
        SELECT s.id
          FROM stories s
          LEFT JOIN story_search ss ON ss.story_id = s.id
         WHERE ${recent} (ss.story_id IS NULL OR ss.source_updated_at < s.updated_at)
         ORDER BY s.updated_at DESC
         LIMIT ${batch}
      )
      SELECT s.id, s.org_id, s.headline, s.body, s.town, s.district, s.updated_at::text AS updated_at, s.created_at::text AS created_at
        FROM cand JOIN stories s ON s.id = cand.id
       ORDER BY s.id`);
    if (!rows.length) return { candidates: 0, written: 0, skipped: 0, locked: false };

    const values = rows.map((r) => {
      const all = [r.headline, r.body, r.town, r.district].filter(Boolean).join(" ");
      return {
        storyId: r.id,
        orgId: r.org_id,
        searchText: searchField(fold(all)),
        searchKey: searchField(phoneticKey(all)),
        headlineText: searchField(fold(r.headline ?? "")),
        headlineKey: searchField(phoneticKey(r.headline ?? "")),
        // Exact timestamps from the text form (drizzle types these as Date; an SQL value is accepted at run time)
        sourceUpdatedAt: sql`${r.updated_at}::timestamptz` as unknown as Date,
        createdAt: sql`${r.created_at}::timestamptz` as unknown as Date,
      };
    });
    const upsert = (t: Pick<Db, "insert">, v: typeof values) =>
      t
        .insert(storySearch)
        .values(v)
        .onConflictDoUpdate({
          target: storySearch.storyId,
          set: {
            orgId: sql`excluded.org_id`,
            searchText: sql`excluded.search_text`,
            searchKey: sql`excluded.search_key`,
            headlineText: sql`excluded.headline_text`,
            headlineKey: sql`excluded.headline_key`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
            createdAt: sql`excluded.created_at`,
          },
          // Never over a row built from a newer version of the story
          setWhere: sql`${storySearch.sourceUpdatedAt} < excluded.source_updated_at`,
        });

    let skipped = 0;
    try {
      await tx.transaction((t) => upsert(t, values));
    } catch {
      for (const v of values) {
        try {
          await tx.transaction((t) => upsert(t, [v]));
        } catch (err) {
          skipped += 1;
          opts.log?.warn({ err, storyId: v.storyId }, "story search: could not index this story; skipped");
        }
      }
    }
    return { candidates: rows.length, written: rows.length - skipped, skipped, locked: false };
  });
}

/** Runs the full sweep until every story has a current row (the backfill). Returns the rows written. */
export async function backfillStorySearch(db: Db, onBatch?: (written: number, total: number) => void, log?: SearchSweepLog): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await syncStorySearch(db, { log });
    if (r.locked) {
      // The worker is sweeping right now: wait for it
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    total += r.written;
    if (r.written) onBatch?.(r.written, total);
    if (r.candidates < SEARCH_SWEEP_BATCH) return total;
  }
}

// ---- The search -------------------------------------------------------------------------------------------------

/** How a story matched, best first: literal folded text, a glossary / district form, the Roman / phonetic key */
export type StoryMatch = "text" | "translated" | "phonetic";

/** matchRank: 4 typed text, 3 glossary / district text, 2 glossary / district key, 1 the typed word's own key */
export function matchOfRank(rank: number): StoryMatch {
  switch (rank) {
    case 4:
      return "text";
    case 3:
    case 2:
      return "translated";
    case 1:
      return "phonetic";
    default:
      throw new Error(`story search: unknown match rank ${rank}`);
  }
}

/** The most stories (newest first) a search ranks; older matches past this are not considered */
export const SEARCH_CANDIDATE_CAP = 2000;
/** Per search; past it the search is cancelled (SearchTimeoutError) */
export const SEARCH_TIMEOUT_MS = 3000;

/** The search ran past its statement timeout */
export class SearchTimeoutError extends Error {
  constructor() {
    super("story search timed out");
  }
}

export interface StorySearchRow {
  id: string;
  headline: string | null;
  body: string | null;
  district: string | null;
  town: string | null;
  /** The story's X post draft's status (newest when several) */
  draftStatus: string;
  createdAt: Date;
  match: StoryMatch;
}

/** The rank order (see storySearchSql), on the page CTE's columns */
const RANK_ORDER = ["head_text DESC", "whole DESC", "match_rank DESC", "head_key DESC", "created_at DESC", "story_id DESC"];

const anyOf = (conds: SQL[]): SQL => (conds.length ? sql`(${sql.join(conds, sql` OR `)})` : sql`false`);
const like = (col: string, pattern: string) => sql`${sql.raw(col)} LIKE ${pattern}`;

/** One word's match conditions on a (text, key) column pair, by the formMatch rules */
function wordConds(w: SearchWord, text: string, key: string) {
  return {
    /** The typed word, or its other ending (हादसा → हादसे) */
    text: anyOf([like(text, searchPattern(w.typed, true)), ...w.variants.map((v) => like(text, searchPattern(v, false)))]),
    translatedText: anyOf(w.texts.slice(1).map((t) => like(text, searchPattern(t, false)))),
    translatedKey: anyOf(w.keys.slice(1).map((k) => like(key, searchPattern(k, false)))),
    phonetic: anyOf(w.keys.slice(0, 1).map((k) => like(key, searchPattern(k, true)))),
    /** Any form or key as a whole word: पुल, not पुलिस */
    whole: anyOf([...[w.typed, ...w.variants, ...w.texts.slice(1)].map((t) => like(text, wholeWordPattern(t))), ...w.keys.map((k) => like(key, wholeWordPattern(k)))]),
  };
}

/**
 * The search statement. The org's desk stories (with an X post draft) matching every word (AND; within a word
 * any form, OR); the newest SEARCH_CANDIDATE_CAP of them are ranked:
 *   1. query words in the headline by their letters (typed or glossary / district text),
 *   2. query words matching a whole word (पुल above पुलिस for "पुल"),
 *   3. the weakest word's best match (typed text > glossary text > glossary key > own key),
 *   4. query words in the headline by key only (a key hit is not ranked above real text: baadh is also बढ़),
 *   5. newest.
 * Each word's flags are worked out once per candidate (flags); stories is joined for the final page only.
 */
export function storySearchSql(orgId: string, words: readonly SearchWord[], limit: number): SQL {
  const all = words.map((w) => wordConds(w, "ss.search_text", "ss.search_key"));
  const head = words.map((w) => wordConds(w, "ss.headline_text", "ss.headline_key"));
  const matches = all.map((c) => sql`(${c.text} OR ${c.translatedText} OR ${c.translatedKey} OR ${c.phonetic})`);
  const flagCols = words.map((_, i) => {
    const c = all[i]!;
    const h = head[i]!;
    return sql.join(
      [
        sql`${c.text} AS ${sql.raw(`t${i}`)}`,
        sql`${c.translatedText} AS ${sql.raw(`tt${i}`)}`,
        sql`${c.translatedKey} AS ${sql.raw(`tk${i}`)}`,
        sql`${c.whole} AS ${sql.raw(`ww${i}`)}`,
        sql`(${h.text} OR ${h.translatedText}) AS ${sql.raw(`ht${i}`)}`,
        sql`(${h.translatedKey} OR ${h.phonetic}) AS ${sql.raw(`hk${i}`)}`,
      ],
      sql`, `,
    );
  });
  const sum = (prefix: string) => sql.raw(words.map((_, i) => `${prefix}${i}::int`).join(" + "));
  const rank = sql.raw(`LEAST(${words.map((_, i) => `CASE WHEN t${i} THEN 4 WHEN tt${i} THEN 3 WHEN tk${i} THEN 2 ELSE 1 END`).join(", ")})`);
  const order = sql.raw(RANK_ORDER.join(", "));
  const pageOrder = sql.raw(RANK_ORDER.map((c) => `page.${c}`).join(", "));

  return sql`
    WITH cand AS (
      SELECT ss.story_id, ss.created_at
        FROM story_search ss
       WHERE ss.org_id = ${orgId}
         AND EXISTS (SELECT 1 FROM post_drafts pd WHERE pd.story_id = ss.story_id AND pd.org_id = ${orgId} AND pd.platform = 'x')
         AND ${sql.join(matches, sql` AND `)}
       ORDER BY ss.created_at DESC, ss.story_id DESC
       LIMIT ${SEARCH_CANDIDATE_CAP}
    ),
    flags AS MATERIALIZED (
      SELECT c.story_id, c.created_at, ${sql.join(flagCols, sql`, `)}
        FROM cand c JOIN story_search ss ON ss.story_id = c.story_id
    ),
    page AS (
      SELECT story_id, created_at, ${sum("ht")} AS head_text, ${sum("ww")} AS whole, ${rank} AS match_rank, ${sum("hk")} AS head_key
        FROM flags
       ORDER BY ${order}
       LIMIT ${limit}
    )
    SELECT s.id, s.headline, s.body, s.district, s.town, s.created_at, page.match_rank,
           (SELECT pd.status FROM post_drafts pd
             WHERE pd.story_id = s.id AND pd.org_id = ${orgId} AND pd.platform = 'x'
             ORDER BY pd.created_at DESC LIMIT 1) AS draft_status
      FROM page JOIN stories s ON s.id = page.story_id AND s.org_id = ${orgId}
     ORDER BY ${pageOrder}`;
}

interface SearchSqlRow extends Record<string, unknown> {
  id: string;
  headline: string | null;
  body: string | null;
  district: string | null;
  town: string | null;
  created_at: Date | string;
  match_rank: number;
  draft_status: string | null;
}

const isStatementTimeout = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "57014" || e?.cause?.code === "57014";
};

/**
 * Runs storySearchSql in its own transaction with a statement timeout (SET LOCAL: this search only).
 * Throws SearchTimeoutError when it runs past `timeoutMs`.
 */
export async function searchStories(
  db: Db,
  orgId: string,
  words: readonly SearchWord[],
  limit: number,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<StorySearchRow[]> {
  if (!words.length) return [];
  const ms = Math.max(1, Math.floor(timeoutMs));
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${ms}ms'`));
      return (await tx.execute<SearchSqlRow>(storySearchSql(orgId, words, limit))).rows;
    });
    return rows.map((r) => ({
      id: r.id,
      headline: r.headline,
      body: r.body,
      district: r.district,
      town: r.town,
      draftStatus: r.draft_status ?? "unknown",
      createdAt: new Date(r.created_at),
      match: matchOfRank(Number(r.match_rank)),
    }));
  } catch (err) {
    if (isStatementTimeout(err)) throw new SearchTimeoutError();
    throw err;
  }
}
