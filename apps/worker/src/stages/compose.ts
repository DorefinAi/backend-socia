// Compose: pure rules turn a story into an X draft. The dictionaries are loaded into memory and
// reloaded when an editor changes them; compose_version records which tables produced a draft.
// Breaking files (phase 1) use their own layout and the district-handles file instead.

import { LEADER_POST, asFileTags, composeBreaking, type Composer } from "@socia/core";
import { dictionaryFingerprint, loadRuleComposer, notify, postDrafts, stories, type Db, type Tx } from "@socia/db";
import { and, eq, sql } from "drizzle-orm";
import { nextStoryIsolated } from "./isolate";
import type { PhaseOneData } from "../data-files";
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

export interface ComposeOptions {
  /** Phase 1: a draft goes straight to the queue with no card; "Add card" asks for one */
  cardOnDemand?: boolean;
  /** The places and district-handles files, for breaking stories (required when any arrive) */
  data?: PhaseOneData;
}

/** Draft states that already went (or are going) out: a re-saved file never rewrites them */
const SENT = ["published", "recalled", "queued", "publishing"];

async function composeBreakingStory(tx: Tx, story: typeof stories.$inferSelect, log: Logger, opts: ComposeOptions) {
  if (!opts.data) throw new Error("Breaking stories need the places and handles files (compose started without them)");
  const { value: book, version: placesVersion } = await opts.data.places.get();
  const { value: rules, version: handlesVersion } = await opts.data.handles.get();
  const tags = asFileTags(story.fileTags);
  const place = book.district(story.district);
  const headline = story.headline ?? "";
  const out = composeBreaking(
    {
      headline,
      points: (story.body ?? "").split("\n").filter(Boolean),
      district: story.district,
      town: story.town,
      // No place: Rajasthan, unless the file came from the national desk
      rajasthan: place ? place.rajasthan : !tags?.other.includes("NWS"),
      leaderPost: LEADER_POST.test(headline),
    },
    rules,
    book,
    `p${placesVersion}.h${handlesVersion}`,
  );
  const needsCheck = out.headlineCut && !story.needsCheck.includes("headline_cut") ? [...story.needsCheck, "headline_cut"] : story.needsCheck;
  const content = {
    bodyText: out.bodyText,
    cardHeadline: headline,
    hashtags: out.hashtags,
    mentions: out.mentions,
    // The rule-picked handles are in the post already; as suggestions too, they stay valid when the post is edited
    mentionSuggestions: out.handles.map((h) => ({ handleId: `rule:${h.reason}:${h.handle}`, entity: h.reason, handle: `@${h.handle}`, exact: true })),
    composeMethod: "rules",
    composeVersion: out.composeVersion,
  };

  // A re-saved file (the ingest stage sent its story back here): rewrite the unposted draft in place
  const [existing] = await tx.select().from(postDrafts).where(and(eq(postDrafts.storyId, story.id), eq(postDrafts.platform, "x"))).for("update");
  if (existing) {
    if (SENT.includes(existing.status)) {
      // Posted between the re-save and now: the post stays as it went out; the story keeps the new text
      log.warn({ storyId: story.id, draftId: existing.id, status: existing.status }, "re-saved file's draft already went out; draft left as it is");
    } else {
      const [row] = await tx
        .update(postDrafts)
        .set({
          ...content,
          // A card already asked for is drawn again with the new headline; none asked for stays none
          ...(existing.cardRev > 0 && existing.cardHeadline !== headline && { cardRev: sql`${postDrafts.cardRev} + 1` }),
          version: sql`${postDrafts.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(postDrafts.id, existing.id))
        .returning({ status: postDrafts.status, version: postDrafts.version });
      await notify(tx, story.orgId, { type: "draft.updated", draftId: existing.id, status: row!.status, version: row!.version });
      log.info({ storyId: story.id, draftId: existing.id }, "re-saved file: draft rewritten in place");
    }
    await tx.update(stories).set({ status: "composed", needsCheck, updatedAt: sql`now()` }).where(eq(stories.id, story.id));
    return;
  }

  const ready = !!opts.cardOnDemand;
  const [draft] = await tx
    .insert(postDrafts)
    .values({ orgId: story.orgId, storyId: story.id, platform: "x", status: ready ? "ready" : "rendering", ...(ready && { cardRev: 0 }), ...content })
    .onConflictDoNothing()
    .returning({ id: postDrafts.id });
  await tx.update(stories).set({ status: "composed", needsCheck, updatedAt: sql`now()` }).where(eq(stories.id, story.id));
  // With no card to wait for the draft is in the queue now; otherwise the render worker announces it
  if (draft && ready) await notify(tx, story.orgId, { type: "story.arrived", storyId: story.id, draftIds: [draft.id] });
  log.info({ storyId: story.id, draftId: draft?.id, district: story.district, handles: out.mentions }, "breaking draft composed");
}

export async function composeNext(db: Db, dictionaries: Dictionaries, log: Logger, opts: ComposeOptions = {}): Promise<boolean> {
  return nextStoryIsolated(db, "converted", log, "compose", async (tx, story) => {
    if (story.layout === "breaking") return composeBreakingStory(tx, story, log, opts);

    const { composer } = await dictionaries.composer();
    const content = await composer.compose({ headline: story.headline ?? "", body: story.body ?? "", place: story.district }, "x");

    const [draft] = await tx
      .insert(postDrafts)
      .values({
        orgId: story.orgId,
        storyId: story.id,
        platform: "x",
        status: opts.cardOnDemand ? "ready" : "rendering",
        ...(opts.cardOnDemand && { cardRev: 0 }),
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
    if (draft && opts.cardOnDemand) await notify(tx, story.orgId, { type: "story.arrived", storyId: story.id, draftIds: [draft.id] });
    log.info({ storyId: story.id, draftId: draft?.id, hashtags: content.hashtags, suggestions: content.mentionSuggestions.length }, "draft composed");
  });
}
