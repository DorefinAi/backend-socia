// The handle and hashtag library learns from what the desk posts (owner decision, 20 Nov 2026: no human review).
// The decisions are core learn.ts; this writes them, at the moment a breaking post goes out (Approve, Mark posted,
// Copy & Posted call learnFromPost next to the hashtag staging), and once over old posts (scripts/learn-tags-backfill).
//
//   - A desk handle (handle_directory source "desk", verified) that the DESK TYPED on the post (typedHandles: not one
//     the composer put on it or offered, which only fed the composer back its own picks) learns its own names in the
//     story as keywords (core handleStoryNames: the story's district and town when in the handle's own district, its
//     own subject), unless the add rules withhold them (a data-file handle or lookalike, a typo or stub of another
//     directory handle, a party's, an official's, a reporter's). verified_at is bumped so the worker's dictionary
//     fingerprint reloads the rows.
//   - A hashtag an editor typed that no rule offered becomes an active topic rule (match_type "entity"), or adds to
//     the one this loop made for it before; never a footer tag, never a second rule for a tag an editor's rule has
//     (any case). A tag with nothing to match on is saved inactive,
//     and one that names no known place or subject stays inactive until it has gone out on UNKNOWN_TAG_POSTS (2)
//     different stories. hashtag_staging keeps its row; promoted_at is set.
//
// Every change is audited (handle.keywords_learned, hashtag.rule_learned). It all runs in a savepoint: if learning
// fails, the post still goes out and the failure is logged.

import { LEARNED_RULE_PRIORITY, MAX_HANDLE_KEYWORDS, MAX_RULE_KEYWORDS, NATIONAL_FOOTER, RAJASTHAN_FOOTER, isFooterTag, mergeKeywords, type LearnStory, type PostedLearner } from "@socia/core";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Executor } from "./client";
import { auditLog, composerCityTags, handleDirectory, hashtagRules, hashtagStaging, postDecisions, postDrafts, stories } from "./schema";

/** Who the change is recorded as: the person who posted, or (actorId null) a named script */
export interface LearnWho {
  orgId: string;
  actorId: string | null;
  actor?: string | null;
}

export type LearnedTagAction = "created" | "updated" | "unchanged" | "duplicate" | "footer";

/** What learning from one post did (or, in a dry run, would do) */
export interface LearnedReport {
  draftId: string;
  names: string[];
  /** `like`: the known handle a typo or stub was withheld for ("did you mean"); `names`: what the handle could learn here */
  handles: { handle: string; added: string[]; keywords: number; withheld: string | null; like?: string | null; names?: string[] }[];
  tags: { tag: string; action: LearnedTagAction; active: boolean; keywords: string[]; ruleId: string | null }[];
}

export interface LearnLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

type Draft = Pick<typeof postDrafts.$inferSelect, "id" | "orgId" | "storyId" | "handlePick" | "hashtags" | "hashtagSuggestions" | "mentions"> & {
  /** The older mention suggestions (offered, never typed), when the caller read them */
  mentionSuggestions?: unknown;
};

const bare = (s: string) => s.trim().replace(/^[#@]+/, "");
const DEVANAGARI = /[ऀ-ॿ]/;

/** The handles of a draft's mention_suggestions ([{ handle: "@JDAJaipur", ... }]); anything else gives none */
function suggestedMentions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((m) => (m && typeof m === "object" && typeof (m as { handle?: unknown }).handle === "string" ? (m as { handle: string }).handle : "")).filter(Boolean);
}

/**
 * The handles the DESK typed on the post (learning fix 1), lower-case without the @: its mentions minus every handle
 * the composer put on it or offered (handle_pick handles and suggested, mention_suggestions) and minus every handle the
 * decision log's proposals hold (`proposed`, any layer). A handle the composer emitted or the desk accepted from the
 * suggestions is never learned from: that only fed the composer back its own picks (@jpr_rural, @JaipurDiscom1).
 */
export function typedHandles(draft: Pick<Draft, "mentions" | "handlePick" | "mentionSuggestions">, proposed: readonly string[] = []): string[] {
  const offered = [
    ...(draft.handlePick?.handles ?? []).map((h) => h.handle),
    ...(draft.handlePick?.suggested ?? []).map((h) => h.handle),
    ...suggestedMentions(draft.mentionSuggestions),
    ...proposed,
  ];
  const known = new Set(offered.map((h) => bare(h).toLowerCase()).filter(Boolean));
  return [...new Set(draft.mentions.map((m) => bare(m).toLowerCase()).filter((k) => k && !known.has(k)))];
}

/**
 * The tags an editor typed on the post that no rule offered (stagePostedHashtags' rule), keyed lower-case without the #.
 * Never the footer, a suggestion, or a city tag the composer put on the post itself (b9 headingPlace.tags: "#Jaipur" in the
 * tag line is the composer's, not the desk's, and must not become a topic rule).
 */
export function typedHashtags(draft: Pick<Draft, "hashtags" | "hashtagSuggestions"> & { handlePick?: Draft["handlePick"] }): Map<string, string> {
  const known = new Set([RAJASTHAN_FOOTER, NATIONAL_FOOTER, ...draft.hashtagSuggestions].map((t) => bare(t).toLowerCase()));
  for (const t of composerCityTags(draft.handlePick)) known.add(t);
  const out = new Map<string, string>();
  for (const raw of draft.hashtags) {
    const tag = raw.trim();
    const key = bare(tag).toLowerCase();
    if (!key || known.has(key) || out.has(key)) continue;
    out.set(key, `#${bare(tag)}`);
  }
  return out;
}

/**
 * Learn from one post: its desk handles and its typed hashtags. Breaking drafts only (they carry a handle_pick, as the
 * staging requires). Null when there is no learner (the data files are not loaded: nothing is learned rather than
 * learning without the safety lists) or when learning failed (rolled back to its savepoint and logged).
 */
export async function learnFromPost(tx: Executor, who: LearnWho, draft: Draft, learner: PostedLearner | null | undefined, log?: LearnLogger): Promise<LearnedReport | null> {
  if (!learner || draft.handlePick === null) return null;
  try {
    return await tx.transaction(async (sp) => {
      const [story] = await sp.select({ headline: stories.headline, body: stories.body, district: stories.district, town: stories.town }).from(stories).where(eq(stories.id, draft.storyId));
      const names = story ? learner.storyNames(story satisfies LearnStory) : [];
      const report: LearnedReport = { draftId: draft.id, names, handles: [], tags: [] };
      const directory = (await sp.select({ handle: handleDirectory.handle }).from(handleDirectory).where(and(eq(handleDirectory.orgId, who.orgId), eq(handleDirectory.platform, "x")))).map((r) => r.handle);
      await learnHandles(sp, who, draft, story ?? null, directory, learner, report);
      await learnHashtags(sp, who, draft, names, learner, report);
      return report;
    });
  } catch (err) {
    (log ?? { error: (obj, msg) => console.error(msg, obj) }).error({ err, orgId: who.orgId, draftId: draft.id }, "tag learning failed and was rolled back; the post went through");
    return null;
  }
}

/** The handles the decision log says the composer proposed for this draft (emitted or offered), as written there */
async function proposedHandles(tx: Executor, draftId: string): Promise<string[]> {
  const [row] = await tx.select({ proposals: postDecisions.proposals }).from(postDecisions).where(eq(postDecisions.draftId, draftId));
  return (row?.proposals ?? []).filter((p) => p.kind === "handle").map((p) => p.item);
}

async function learnHandles(tx: Executor, who: LearnWho, draft: Draft, story: LearnStory | null, directory: string[], learner: PostedLearner, report: LearnedReport): Promise<void> {
  if (!draft.mentions.length) return;
  const keys = typedHandles(draft, await proposedHandles(tx, draft.id));
  if (!keys.length) return;
  const rows = await tx
    .select({ id: handleDirectory.id, handle: handleDirectory.handle, aliases: handleDirectory.aliases })
    .from(handleDirectory)
    .where(
      and(
        eq(handleDirectory.orgId, who.orgId),
        eq(handleDirectory.platform, "x"),
        eq(handleDirectory.source, "desk"),
        isNotNull(handleDirectory.verifiedAt),
        inArray(sql`lower(ltrim(${handleDirectory.handle}, '@'))`, keys),
      ),
    )
    .orderBy(handleDirectory.createdAt)
    .for("update");
  if (!rows.length) return;
  const done = new Set<string>();
  for (const row of rows) {
    const handle = `@${bare(row.handle)}`;
    if (done.has(handle.toLowerCase())) continue;
    done.add(handle.toLowerCase());
    const withheld = learner.handleWithheld(row.handle, directory);
    const like = withheld === "lookalike" ? learner.handleLookalike(row.handle, directory) : null;
    const names = story ? learner.handleNames(row.handle, story) : [];
    const { keywords, added } = withheld ? { keywords: row.aliases, added: [] } : mergeKeywords(row.aliases, names, MAX_HANDLE_KEYWORDS);
    report.handles.push({ handle, added, keywords: keywords.length, withheld, ...(like && { like: `@${like}` }), names });
    if (!added.length) continue;
    // verified_at doubles as the directory's change stamp (dictionaryFingerprint): bumping it reloads the worker's rows
    await tx
      .update(handleDirectory)
      .set({ aliases: keywords, verifiedAt: sql`CASE WHEN ${handleDirectory.verifiedAt} IS NULL THEN NULL ELSE now() END` })
      .where(eq(handleDirectory.id, row.id));
    await audit(tx, {
      orgId: who.orgId, actorId: who.actorId, actor: who.actor ?? null, action: "handle.keywords_learned", entityType: "handle", entityId: row.id,
      before: { handle, aliases: row.aliases }, after: { handle, aliases: keywords, added, draftId: draft.id },
    });
  }
}

/** The hashtag_rules rows a tag already has (hashtag_latin or hashtag_devanagari, any case, with or without the #) */
async function rulesForTag(tx: Executor, orgId: string, tagKey: string) {
  return tx
    .select()
    .from(hashtagRules)
    .where(
      and(
        eq(hashtagRules.orgId, orgId),
        sql`(lower(ltrim(${hashtagRules.hashtagLatin}, '#')) = ${tagKey} OR lower(ltrim(coalesce(${hashtagRules.hashtagDevanagari}, ''), '#')) = ${tagKey})`,
      ),
    )
    .orderBy(hashtagRules.updatedAt);
}

/**
 * The rule of these that this loop made and no editor has touched since (no hashtag_rule.* audit row: an edit or a
 * delete in Settings is the editor's call and is never undone here); null when there is none.
 */
async function learnedRule(tx: Executor, orgId: string, rules: (typeof hashtagRules.$inferSelect)[]) {
  if (!rules.length) return null;
  const actions = await tx
    .select({ id: auditLog.entityId, action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityType, "hashtag_rule"), inArray(auditLog.entityId, rules.map((r) => r.id))));
  return rules.find((r) => actions.some((a) => a.id === r.id && a.action === "hashtag.rule_learned") && !actions.some((a) => a.id === r.id && a.action.startsWith("hashtag_rule."))) ?? null;
}

/**
 * A tag that names no known district, place or subject is offered only once it has gone out on this many different
 * stories (owner, 20 Nov 2026): one-off typos (#bbhbh) are saved but stay off. A known one is offered after one post.
 */
export const UNKNOWN_TAG_POSTS = 2;

/** The different drafts this loop has learned a rule from (its hashtag.rule_learned audit rows), plus this one */
async function rulePosts(tx: Executor, orgId: string, ruleId: string, draftId: string): Promise<number> {
  const rows = await tx
    .select({ draftId: sql<string | null>`${auditLog.after}->>'draftId'` })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityType, "hashtag_rule"), eq(auditLog.entityId, ruleId), eq(auditLog.action, "hashtag.rule_learned")));
  return new Set([...rows.map((r) => r.draftId).filter((d): d is string => !!d), draftId]).size;
}

async function learnHashtags(tx: Executor, who: LearnWho, draft: Draft, names: string[], learner: PostedLearner, report: LearnedReport): Promise<void> {
  for (const [tagKey, tag] of typedHashtags(draft)) {
    if (isFooterTag(tag)) {
      report.tags.push({ tag, action: "footer", active: false, keywords: [], ruleId: null });
      continue;
    }
    // One learner per tag at a time: two posts with the same new tag make one rule
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hashtag_rules:${who.orgId}:${tagKey}`}))`);
    const fresh = learner.tagKeywords(tag, names);
    const existing = await rulesForTag(tx, who.orgId, tagKey);
    if (existing.length) {
      const rule = await learnedRule(tx, who.orgId, existing);
      if (!rule) {
        report.tags.push({ tag, action: "duplicate", active: existing.some((r) => r.active), keywords: [], ruleId: existing[0]!.id });
        continue;
      }
      // A rule saved with no keywords has only the tag as its name; any other name is its first keyword (an unknown tag
      // waiting for its second story is inactive but already has keywords)
      const nameIsTag = !rule.active && rule.aliases.length === 0 && rule.name.toLowerCase() === bare(tag).toLowerCase();
      const had = nameIsTag ? [] : [rule.name, ...rule.aliases];
      const { keywords, added } = mergeKeywords(had, fresh.keywords, MAX_RULE_KEYWORDS);
      const active = keywords.length > 0 && (fresh.known || (await rulePosts(tx, who.orgId, rule.id, draft.id)) >= UNKNOWN_TAG_POSTS);
      if (!added.length && active === rule.active) {
        report.tags.push({ tag, action: "unchanged", active, keywords, ruleId: rule.id });
        continue;
      }
      const [after] = await tx
        .update(hashtagRules)
        .set({ name: keywords[0] ?? rule.name, aliases: keywords.slice(1), active, updatedAt: sql`now()` })
        .where(eq(hashtagRules.id, rule.id))
        .returning();
      await audit(tx, {
        orgId: who.orgId, actorId: who.actorId, actor: who.actor ?? null, action: "hashtag.rule_learned", entityType: "hashtag_rule", entityId: rule.id,
        before: rule, after: { ...after, tag, added, draftId: draft.id, created: false },
      });
      report.tags.push({ tag, action: "updated", active, keywords, ruleId: rule.id });
      continue;
    }
    const keywords = fresh.keywords;
    // A first post: a known tag is offered at once; any other waits for its second story (UNKNOWN_TAG_POSTS)
    const active = keywords.length > 0 && (fresh.known || UNKNOWN_TAG_POSTS <= 1);
    const text = bare(tag);
    const [row] = await tx
      .insert(hashtagRules)
      .values({
        orgId: who.orgId, matchType: "entity", name: keywords[0] ?? text, aliases: keywords.slice(1), hashtagLatin: text, hashtagDevanagari: DEVANAGARI.test(text) ? text : null,
        priority: LEARNED_RULE_PRIORITY, negativePhrases: [], active,
      })
      .returning();
    await tx
      .update(hashtagStaging)
      .set({ promotedAt: sql`now()` })
      .where(and(eq(hashtagStaging.orgId, who.orgId), eq(hashtagStaging.tagKey, tagKey), isNull(hashtagStaging.promotedAt)));
    await audit(tx, {
      orgId: who.orgId, actorId: who.actorId, actor: who.actor ?? null, action: "hashtag.rule_learned", entityType: "hashtag_rule", entityId: row!.id,
      after: { ...row, tag, known: fresh.known, draftId: draft.id, created: true },
    });
    report.tags.push({ tag, action: "created", active, keywords, ruleId: row!.id });
  }
}
