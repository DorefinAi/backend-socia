// The handle and hashtag library learns from what the desk posts (owner decision, 20 Nov 2026: no human review).
// The decisions are core learn.ts; this writes them, at the moment a breaking post goes out (Approve, Mark posted,
// Copy & Posted call learnFromPost next to the hashtag staging), and once over old posts (scripts/learn-tags-backfill).
//
//   - A desk handle (handle_directory source "desk", verified) on the post learns the names the system recognises in
//     the story as keywords, unless the add rules withhold them (a data-file handle or lookalike, a party's, an
//     official's, a reporter's). verified_at is bumped so the worker's dictionary fingerprint reloads the rows.
//   - A hashtag an editor typed that no rule offered becomes an active topic rule (match_type "entity"), or adds to
//     the one this loop made for it before; never a footer tag, never a second rule for a tag an editor's rule has
//     (any case). A tag with nothing to match on is saved inactive. hashtag_staging keeps its row; promoted_at is set.
//
// Every change is audited (handle.keywords_learned, hashtag.rule_learned). It all runs in a savepoint: if learning
// fails, the post still goes out and the failure is logged.

import { LEARNED_RULE_PRIORITY, MAX_HANDLE_KEYWORDS, MAX_RULE_KEYWORDS, NATIONAL_FOOTER, RAJASTHAN_FOOTER, isFooterTag, mergeKeywords, type LearnStory, type PostedLearner } from "@socia/core";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Executor } from "./client";
import { auditLog, handleDirectory, hashtagRules, hashtagStaging, postDrafts, stories } from "./schema";

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
  handles: { handle: string; added: string[]; keywords: number; withheld: string | null }[];
  tags: { tag: string; action: LearnedTagAction; active: boolean; keywords: string[]; ruleId: string | null }[];
}

export interface LearnLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

type Draft = Pick<typeof postDrafts.$inferSelect, "id" | "orgId" | "storyId" | "handlePick" | "hashtags" | "hashtagSuggestions" | "mentions">;

const bare = (s: string) => s.trim().replace(/^[#@]+/, "");
const DEVANAGARI = /[ऀ-ॿ]/;

/** The tags an editor typed on the post that no rule offered (stagePostedHashtags' rule), keyed lower-case without the # */
export function typedHashtags(draft: Pick<Draft, "hashtags" | "hashtagSuggestions">): Map<string, string> {
  const known = new Set([RAJASTHAN_FOOTER, NATIONAL_FOOTER, ...draft.hashtagSuggestions].map((t) => bare(t).toLowerCase()));
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
      await learnHandles(sp, who, draft, names, learner, report);
      await learnHashtags(sp, who, draft, names, learner, report);
      return report;
    });
  } catch (err) {
    (log ?? { error: (obj, msg) => console.error(msg, obj) }).error({ err, orgId: who.orgId, draftId: draft.id }, "tag learning failed and was rolled back; the post went through");
    return null;
  }
}

async function learnHandles(tx: Executor, who: LearnWho, draft: Draft, names: string[], learner: PostedLearner, report: LearnedReport): Promise<void> {
  const keys = [...new Set(draft.mentions.map((m) => bare(m).toLowerCase()).filter(Boolean))];
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
  const directory = (await tx.select({ handle: handleDirectory.handle }).from(handleDirectory).where(and(eq(handleDirectory.orgId, who.orgId), eq(handleDirectory.platform, "x")))).map((r) => r.handle);
  const done = new Set<string>();
  for (const row of rows) {
    const handle = `@${bare(row.handle)}`;
    if (done.has(handle.toLowerCase())) continue;
    done.add(handle.toLowerCase());
    const withheld = learner.handleWithheld(row.handle, directory);
    const { keywords, added } = withheld ? { keywords: row.aliases, added: [] } : mergeKeywords(row.aliases, names, MAX_HANDLE_KEYWORDS);
    report.handles.push({ handle, added, keywords: keywords.length, withheld });
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
      // A rule saved inactive has no keywords yet: its name is only the tag
      const had = rule.active ? [rule.name, ...rule.aliases] : rule.aliases;
      const { keywords, added } = mergeKeywords(had, fresh.keywords, MAX_RULE_KEYWORDS);
      const active = keywords.length > 0;
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
    const active = keywords.length > 0;
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
