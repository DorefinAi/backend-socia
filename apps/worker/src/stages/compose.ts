// Compose: pure rules turn a story into an X draft. The dictionaries are loaded into memory and
// reloaded when an editor changes them; compose_version records which tables produced a draft.

import type { Composer } from "@socia/core";
import { dictionaryFingerprint, loadRuleComposer, postDrafts, stories, withNextStory, type Db } from "@socia/db";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";

const RELOAD_MS = 60_000;

export class Dictionaries {
  private cached: { composer: Composer; version: string; at: number } | null = null;

  constructor(private readonly db: Db, private readonly orgId: string) {}

  async composer(): Promise<{ composer: Composer; version: string }> {
    if (this.cached && Date.now() - this.cached.at < RELOAD_MS) return this.cached;
    const version = await dictionaryFingerprint(this.db, this.orgId);
    if (this.cached?.version === version) {
      this.cached.at = Date.now();
      return this.cached;
    }
    const { composer } = await loadRuleComposer(this.db, this.orgId, version);
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
