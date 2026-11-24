// The rule composer built from the org's tables: settings, active hashtag rules, verified X handles.
// The compose worker caches it (reloading when the tables change); the API builds one when a desk
// action makes a story directly (a Web Scraper trend).

import { RuleComposer, handleGazetteer, hashtagGazetteer, type DeskHandleEvidence, type HashtagRule, type LearnStory, type MatchType, type SuggestStats } from "@socia/core";
import { and, count, eq, isNotNull, max, notInArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { REPORTER_SOURCE, handleDirectory, hashtagRules, orgs, postDecisions, postDrafts, publishedPosts, stories } from "./schema";

/** A fingerprint of both dictionaries: any edit, add or delete changes it */
export async function dictionaryFingerprint(db: Db, orgId: string): Promise<string> {
  const [h] = await db.select({ n: count(), at: max(hashtagRules.updatedAt) }).from(hashtagRules).where(and(eq(hashtagRules.orgId, orgId), eq(hashtagRules.active, true)));
  const [d] = await db
    .select({ n: count(), at: max(handleDirectory.verifiedAt) })
    .from(handleDirectory)
    .where(and(eq(handleDirectory.orgId, orgId), isNotNull(handleDirectory.verifiedAt)));
  return `rules-${h?.n ?? 0}.${h?.at?.getTime() ?? 0}-handles-${d?.n ?? 0}.${d?.at?.getTime() ?? 0}`;
}

/** The org's active hashtag rules in the core shape */
export async function activeHashtagRules(db: Db, orgId: string): Promise<HashtagRule[]> {
  const rules = await db.select().from(hashtagRules).where(and(eq(hashtagRules.orgId, orgId), eq(hashtagRules.active, true)));
  return rules.map((r) => ({ id: r.id, matchType: r.matchType as MatchType, name: r.name, aliases: r.aliases, hashtagLatin: r.hashtagLatin, hashtagDevanagari: r.hashtagDevanagari, priority: r.priority, negativePhrases: r.negativePhrases }));
}

export async function loadRuleComposer(db: Db, orgId: string, version?: string): Promise<{ composer: RuleComposer; version: string }> {
  const v = version ?? (await dictionaryFingerprint(db, orgId));
  const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) throw new Error(`ORG_ID ${orgId} is not in the orgs table`);
  // Handles the desk added from a tag line (source "desk") are suggested only by the phase-1 breaking composer,
  // under its safety rules (core desk-handles.ts); this composer (non-breaking stories, Web Scraper trends) has none.
  // Reporter rows are excluded for a sharper reason: their aliases are file-name tokens ("ASHOK",
  // "PK_AGARWAL"), so in a general gazetteer they would suggest a reporter's handle on any copy that
  // happens to contain that word. They mean something only as a breaking file's byline.
  const handles = await db
    .select()
    .from(handleDirectory)
    .where(
      and(
        eq(handleDirectory.orgId, orgId),
        eq(handleDirectory.platform, "x"),
        isNotNull(handleDirectory.verifiedAt),
        notInArray(handleDirectory.source, ["desk", REPORTER_SOURCE]),
      ),
    );
  const composer = new RuleComposer({
    version: v,
    hashtagConfig: { script: org.settings.hashtagScript, fixed: org.settings.fixedHashtags, max: org.settings.maxHashtags },
    hashtags: hashtagGazetteer(await activeHashtagRules(db, orgId)),
    handles: handleGazetteer(
      handles.map((h) => ({ id: h.id, entityName: h.entityName, aliases: [...h.aliases, ...(h.entityNameHi ? [h.entityNameHi] : [])], handle: h.handle, priority: h.priority })),
    ),
  });
  return { composer, version: v };
}

/** A handle that is safe to put in a regular expression: an X handle's letters, digits and underscore only */
const PLAIN_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * How many of the org's live published posts (not recalled) carry each handle as a whole "@handle", any case: the
 * "posted at least 2 times" count that takes a Settings handle out of suggest-only (handle fixes F1, G4).
 * "@JaipurMetro" is counted in "… @JaipurMetro @jaipur_police", not in "@JaipurMetroRail". Handles are given bare or
 * with the @; the map is keyed by the lower-cased bare handle. A handle that is not a plain X handle counts 0.
 */
export async function handlePostedUses(db: Db, orgId: string, handles: readonly string[]): Promise<Map<string, number>> {
  const keys = [...new Set(handles.map((h) => h.trim().replace(/^@+/, "").toLowerCase()))];
  const out = new Map<string, number>(keys.map((k) => [k, 0]));
  const plain = keys.filter((k) => PLAIN_HANDLE.test(k));
  if (!plain.length) return out;
  const res = await db.execute<{ handle: string; n: number }>(sql`
    SELECT h.handle, count(p.id)::int AS n
    FROM unnest(ARRAY[${sql.join(plain.map((k) => sql`${k}`), sql`, `)}]::text[]) AS h(handle)
    LEFT JOIN ${publishedPosts} p
      ON p.org_id = ${orgId} AND p.recalled_at IS NULL
     AND strpos(lower(p.text), '@' || h.handle) > 0
     AND p.text ~* ('(^|[^A-Za-z0-9_])@' || h.handle || '([^A-Za-z0-9_]|$)')
    GROUP BY h.handle`);
  for (const r of res.rows) out.set(r.handle, Number(r.n));
  return out;
}

/** A decided row's item_outcomes as rows (none when the column is null or not an array) */
const OUTCOMES = sql`jsonb_array_elements(CASE WHEN jsonb_typeof(pd.item_outcomes) = 'array' THEN pd.item_outcomes ELSE '[]'::jsonb END)`;

/**
 * The stories of the org's live published posts on which the DESK TYPED each handle (a whole "@handle" in the post,
 * any case, and the decision log's item_outcomes record it as desk_added: no rule put it there or offered it), each
 * story once per handle: what a desk handle's learned keywords are counted against (core learn.ts keywordPostedCounts,
 * learning fix 4). A post where the composer emitted the handle, or the desk took it from the suggestions, is not
 * evidence: counting those let a handle feed on its own picks. Keyed by the lower-cased bare handle; a handle that is
 * not a plain X handle has none.
 */
export async function handlePostedStories(db: Db, orgId: string, handles: readonly string[]): Promise<Map<string, LearnStory[]>> {
  const keys = [...new Set(handles.map((h) => h.trim().replace(/^@+/, "").toLowerCase()))];
  const out = new Map<string, LearnStory[]>(keys.map((k) => [k, []]));
  const plain = keys.filter((k) => PLAIN_HANDLE.test(k));
  if (!plain.length) return out;
  const res = await db.execute<{ handle: string; headline: string | null; body: string | null; district: string | null; town: string | null }>(sql`
    SELECT DISTINCT ON (h.handle, s.id) h.handle, s.headline, s.body, s.district, s.town
    FROM unnest(ARRAY[${sql.join(plain.map((k) => sql`${k}`), sql`, `)}]::text[]) AS h(handle)
    JOIN ${publishedPosts} p
      ON p.org_id = ${orgId} AND p.recalled_at IS NULL
     AND strpos(lower(p.text), '@' || h.handle) > 0
     AND p.text ~* ('(^|[^A-Za-z0-9_])@' || h.handle || '([^A-Za-z0-9_]|$)')
    JOIN ${postDecisions} pd ON pd.draft_id = p.draft_id
    JOIN ${postDrafts} d ON d.id = p.draft_id
    JOIN ${stories} s ON s.id = d.story_id
    WHERE EXISTS (
      SELECT 1 FROM ${OUTCOMES} AS o
      WHERE o->>'kind' = 'handle' AND o->>'outcome' = 'desk_added' AND lower(ltrim(o->>'item', '@')) = h.handle
    )`);
  for (const r of res.rows) out.get(r.handle)?.push({ headline: r.headline, body: r.body, district: r.district, town: r.town });
  return out;
}

/**
 * Each handle's record as a desk suggestion (item_outcomes, layer "suggest", source "desk") over the org's decided,
 * not rejected drafts: offered = accepted + ignored. What core suggestionRetired reads (learning fix 7). Keyed like
 * handlePostedStories; a handle never offered is 0/0.
 */
export async function deskSuggestionStats(db: Db, orgId: string, handles: readonly string[]): Promise<Map<string, SuggestStats>> {
  const keys = [...new Set(handles.map((h) => h.trim().replace(/^@+/, "").toLowerCase()))];
  const out = new Map<string, SuggestStats>(keys.map((k) => [k, { offered: 0, accepted: 0 }]));
  const plain = keys.filter((k) => PLAIN_HANDLE.test(k));
  if (!plain.length) return out;
  const res = await db.execute<{ handle: string; offered: number; accepted: number }>(sql`
    SELECT lower(ltrim(o->>'item', '@')) AS handle,
           count(*) FILTER (WHERE o->>'outcome' IN ('accepted', 'ignored'))::int AS offered,
           count(*) FILTER (WHERE o->>'outcome' = 'accepted')::int AS accepted
    FROM ${postDecisions} pd CROSS JOIN LATERAL ${OUTCOMES} AS o
    WHERE pd.org_id = ${orgId} AND pd.decided_at IS NOT NULL AND pd.decision <> 'rejected'
      AND o->>'kind' = 'handle' AND o->>'layer' = 'suggest' AND o->>'source' = 'desk'
      AND lower(ltrim(o->>'item', '@')) = ANY(ARRAY[${sql.join(plain.map((k) => sql`${k}`), sql`, `)}]::text[])
    GROUP BY 1`);
  for (const r of res.rows) out.set(r.handle, { offered: Number(r.offered), accepted: Number(r.accepted) });
  return out;
}

/**
 * What the worker reads behind each desk handle (core withKeywordUses): the stories the desk typed it on and its
 * record as a suggestion. Keyed like handlePostedStories.
 */
export async function deskHandleEvidence(db: Db, orgId: string, handles: readonly string[]): Promise<Map<string, DeskHandleEvidence>> {
  const [stories, stats] = await Promise.all([handlePostedStories(db, orgId, handles), deskSuggestionStats(db, orgId, handles)]);
  return new Map([...stories].map(([k, s]) => [k, { stories: s, suggest: stats.get(k) ?? { offered: 0, accepted: 0 } }]));
}
