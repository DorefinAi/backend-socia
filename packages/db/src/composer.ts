// The rule composer built from the org's tables: settings, active hashtag rules, verified X handles.
// The compose worker caches it (reloading when the tables change); the API builds one when a desk
// action makes a story directly (a Web Scraper trend).

import { RuleComposer, handleGazetteer, hashtagGazetteer, type HashtagRule, type MatchType } from "@socia/core";
import { and, count, eq, isNotNull, max } from "drizzle-orm";
import type { Db } from "./client";
import { handleDirectory, hashtagRules, orgs } from "./schema";

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
  const handles = await db
    .select()
    .from(handleDirectory)
    .where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.platform, "x"), isNotNull(handleDirectory.verifiedAt)));
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
