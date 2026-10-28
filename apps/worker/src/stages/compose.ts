// Compose: pure rules turn a story into an X draft. The dictionaries are loaded into memory and
// reloaded when an editor changes them; compose_version records which tables produced a draft.

import { RuleComposer, handleGazetteer, hashtagGazetteer, type Composer, type MatchType } from "@socia/core";
import { handleDirectory, hashtagRules, orgs, postDrafts, stories, withNextStory, type Db } from "@socia/db";
import { and, count, eq, isNotNull, max, sql } from "drizzle-orm";
import type { Logger } from "pino";

const RELOAD_MS = 60_000;

export class Dictionaries {
  private cached: { composer: Composer; version: string; at: number } | null = null;

  constructor(private readonly db: Db, private readonly orgId: string) {}

  /** A fingerprint of both tables: any edit, add or delete changes it */
  private async fingerprint(): Promise<string> {
    const [h] = await this.db.select({ n: count(), at: max(hashtagRules.updatedAt) }).from(hashtagRules).where(and(eq(hashtagRules.orgId, this.orgId), eq(hashtagRules.active, true)));
    const [d] = await this.db
      .select({ n: count(), at: max(handleDirectory.verifiedAt) })
      .from(handleDirectory)
      .where(and(eq(handleDirectory.orgId, this.orgId), isNotNull(handleDirectory.verifiedAt)));
    return `rules-${h?.n ?? 0}.${h?.at?.getTime() ?? 0}-handles-${d?.n ?? 0}.${d?.at?.getTime() ?? 0}`;
  }

  async composer(): Promise<{ composer: Composer; version: string }> {
    if (this.cached && Date.now() - this.cached.at < RELOAD_MS) return this.cached;
    const version = await this.fingerprint();
    if (this.cached?.version === version) {
      this.cached.at = Date.now();
      return this.cached;
    }

    const [org] = await this.db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, this.orgId));
    if (!org) throw new Error(`ORG_ID ${this.orgId} is not in the orgs table`);
    const rules = await this.db.select().from(hashtagRules).where(and(eq(hashtagRules.orgId, this.orgId), eq(hashtagRules.active, true)));
    const handles = await this.db
      .select()
      .from(handleDirectory)
      .where(and(eq(handleDirectory.orgId, this.orgId), eq(handleDirectory.platform, "x"), isNotNull(handleDirectory.verifiedAt)));

    const composer = new RuleComposer({
      version,
      hashtagConfig: { script: org.settings.hashtagScript, fixed: org.settings.fixedHashtags, max: org.settings.maxHashtags },
      hashtags: hashtagGazetteer(
        rules.map((r) => ({ id: r.id, matchType: r.matchType as MatchType, name: r.name, aliases: r.aliases, hashtagLatin: r.hashtagLatin, hashtagDevanagari: r.hashtagDevanagari, priority: r.priority })),
      ),
      handles: handleGazetteer(
        handles.map((h) => ({ id: h.id, entityName: h.entityName, aliases: [...h.aliases, ...(h.entityNameHi ? [h.entityNameHi] : [])], handle: h.handle, priority: h.priority })),
      ),
    });
    this.cached = { composer, version, at: Date.now() };
    return this.cached;
  }
}

export async function composeNext(db: Db, dictionaries: Dictionaries, log: Logger): Promise<boolean> {
  return withNextStory(db, "converted", async (tx, story) => {
    const { composer } = await dictionaries.composer();
    const content = await composer.compose({ headline: story.headline ?? "", body: story.body ?? "", place: story.district }, "x");

    const [draft] = await tx
      .insert(postDrafts)
      .values({
        orgId: story.orgId,
        storyId: story.id,
        platform: "x",
        status: "rendering",
        bodyText: content.bodyText,
        cardHeadline: story.headline ?? "",
        hashtags: content.hashtags,
        mentionSuggestions: content.mentionSuggestions,
        composeMethod: content.composeMethod,
        composeVersion: content.composeVersion,
      })
      .onConflictDoNothing()
      .returning({ id: postDrafts.id });
    await tx.update(stories).set({ status: "composed", updatedAt: sql`now()` }).where(eq(stories.id, story.id));
    log.info({ storyId: story.id, draftId: draft?.id, hashtags: content.hashtags, suggestions: content.mentionSuggestions.length }, "draft composed");
  });
}
