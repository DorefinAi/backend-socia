// Convert + parse: Kruti Dev → Unicode, then line 1 = headline. Nothing downstream can be trusted
// until the converter passes the regression set with the control room's real font (doc §11 step 0).

import { SERIOUS_CHECKS, STICKY_CHECKS, conversionConfidence, decodeBreakingFile, decodeBytes, detectEncoding, krutiToUnicode, parseBreaking, parseStory, type BreakingStory } from "@socia/core";
import { ingestedFiles, postDrafts, stories, type Db, type Tx } from "@socia/db";
import type { Storage } from "@socia/providers";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { PhaseOneData } from "../data-files";
import { nextStoryIsolated } from "./isolate";

export function convertText(bytes: Uint8Array) {
  const { text, charset } = decodeBytes(bytes);
  const encoding = detectEncoding(text);
  const unicode = encoding === "krutidev" ? krutiToUnicode(text) : text.normalize("NFC");
  return { sourceText: text, charset, encoding, unicode, confidence: conversionConfidence(unicode), parsed: parseStory(unicode) };
}

/** Plain words for the desk's parse note, one per needs-check reason */
const CHECK_NOTES: Record<string, string> = {
  empty: "The file has no text.",
  resaved: "The file was saved again with new text; the draft was rewritten from it. Check the text.",
  update_of_posted: "This file was saved again after its post went out: this is a new draft. Check what changed before posting.",
  file_deleted: "File is deleted, please check FTP.",
  text_changed: "A word or number of the file is missing from the story text. Check it against the file before posting.",
  no_headline: "No headline line was found.",
  no_hindi: "The file has no Hindi text; check the encoding.",
  very_long: "The file is much longer than a breaking item.",
  no_district: "No district was found in the place line, the file name or the text.",
  place_conflict: "The headline's place tags name more than one district, or a different one from the place line; the first tag was used. Check the district.",
  // desk_note: still recorded when a desk instruction (नोट) is taken out, but not shown as a reason to check
};

/** A breaking file's fields on stories (phase 1 layout) */
export function breakingColumns(b: BreakingStory, sticky: string[] = []) {
  const serious = b.needsCheck.some((c) => SERIOUS_CHECKS.includes(c));
  const needsCheck: string[] = [...b.needsCheck, ...sticky.filter((c) => !(b.needsCheck as string[]).includes(c))];
  return {
    headline: b.headline,
    body: b.points.join("\n"),
    district: b.district,
    // Stated (place line, prefix, tag; the file code unless the reporter is a bureau) or inferred (text): only a
    // stated one reaches the post
    districtFrom: b.districtFrom,
    town: b.town,
    fileTags: b.tags,
    needsCheck,
    deskNote: b.deskNote,
    parseMethod: serious ? "needs_review" : "breaking",
    parseNote: needsCheck.map((c) => CHECK_NOTES[c]).filter(Boolean).join(" ") || null,
  };
}

/** Draft states still waiting in the queue (not sent, not rejected, not failed) */
const UNSENT = ["rendering", "ready", "claimed"];
/** How a withdrawn draft's reason starts: compose brings such a draft back to the queue when the file is fixed */
export const WITHDRAWN_NOTE = "The file was saved again and can't be used: ";

/**
 * A breaking file saved again as something that cannot become a post (unreadable, or no text): the story's draft
 * from the earlier save leaves the queue, to Failed with the reason, so only good, current stories wait there
 * (owner, 15 Nov 2026, M1). A draft that went out, or was rejected, is left alone. Returns its id, or null.
 */
async function withdrawUnsentDraft(tx: Tx, storyId: string, reason: string): Promise<string | null> {
  const [draft] = await tx
    .update(postDrafts)
    .set({ status: "failed", renderError: `${WITHDRAWN_NOTE}${reason}`, claimedBy: null, claimExpiresAt: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(postDrafts.storyId, storyId), inArray(postDrafts.status, UNSENT)))
    .returning({ id: postDrafts.id });
  return draft?.id ?? null;
}

export async function convertNext(db: Db, storage: Storage, stageLog: Logger, data?: PhaseOneData): Promise<boolean> {
  return nextStoryIsolated(db, "ingested", stageLog, "convert", async (tx, story) => {
    // Every line about this story carries its slug (dev-docs/ops-status-contract.md §6); storyId becomes item_id
    const log = stageLog.child({ slug: story.slug });
    // Samvadia stories arrive as Unicode text and skip this stage (status "converted"); a story with no
    // file here is a bug, so park it where the desk can see it rather than loop on it.
    if (!story.fileId) {
      await tx.update(stories).set({ status: "failed", lastError: "No text file to convert", updatedAt: sql`now()` }).where(eq(stories.id, story.id));
      log.error({ storyId: story.id }, "story has no text file; marked failed");
      return;
    }
    const [file] = await tx.select().from(ingestedFiles).where(eq(ingestedFiles.id, story.fileId));
    const bytes = await storage.get(file!.storageKey);

    if (story.layout === "breaking") {
      // Breaking files are Unicode (UTF-8, or Notepad's UTF-16): no Kruti Dev guess (a Latin file-name line can look
      // like Kruti Dev). A file that is not text at all is rejected: failed, out of the queue, the reason logged.
      const decoded = decodeBreakingFile(bytes);
      if ("unreadable" in decoded) {
        await tx.update(stories).set({ status: "failed", lastError: decoded.unreadable, updatedAt: sql`now()` }).where(eq(stories.id, story.id));
        const withdrawn = await withdrawUnsentDraft(tx, story.id, decoded.unreadable);
        log.warn({ storyId: story.id, file: file!.fileName, why: decoded.unreadable, withdrawn }, "breaking file rejected: not readable text");
        return;
      }
      const { text, charset } = decoded;
      const unicode = text.normalize("NFC");
      const result = { sourceText: text, charset, encoding: "unicode", unicode, confidence: conversionConfidence(unicode) };
      if (!data) throw new Error("Breaking stories need the places file (convert started without it)");
      const b = parseBreaking(result.unicode, file!.fileName, (await data.places.get()).value);
      // "resaved" / "update_of_posted" were set by the ingest stage and outlive the re-parse
      const cols = breakingColumns(b, story.needsCheck.filter((c) => (STICKY_CHECKS as readonly string[]).includes(c)));
      // An empty file cannot become a post: it fails (the ingest status counts it) and nothing crashes
      const failed = !b.headline;
      await tx
        .update(stories)
        .set({
          status: failed ? "failed" : "converted",
          sourceText: result.sourceText,
          sourceCharset: result.charset,
          sourceEncoding: result.encoding,
          conversionConfidence: result.confidence,
          ...cols,
          lastError: failed ? (cols.parseNote ?? "The file has no text.") : null,
          updatedAt: sql`now()`,
        })
        .where(eq(stories.id, story.id));
      // A file saved again with no text: its earlier draft leaves the queue too (M1)
      const withdrawn = failed ? await withdrawUnsentDraft(tx, story.id, cols.parseNote ?? "The file has no text.") : null;
      log.info({ storyId: story.id, district: b.district, districtFrom: b.districtFrom, town: b.town, checks: b.needsCheck, ...(withdrawn && { withdrawn }) }, failed ? "breaking file could not be parsed" : "breaking file converted");
      return;
    }

    const result = convertText(bytes);
    const { parsed } = result;

    const failed = !parsed.headline;

    await tx
      .update(stories)
      .set({
        status: failed ? "failed" : "converted",
        sourceText: result.sourceText,
        sourceCharset: result.charset,
        sourceEncoding: result.encoding,
        conversionConfidence: result.confidence,
        headline: parsed.headline,
        body: parsed.body,
        parseMethod: parsed.parseMethod,
        parseNote: parsed.parseNote,
        lastError: failed ? parsed.parseNote : null,
        updatedAt: sql`now()`,
      })
      .where(eq(stories.id, story.id));

    log.info({ storyId: story.id, encoding: result.encoding, confidence: result.confidence, parse: parsed.parseMethod }, failed ? "story could not be parsed" : "story converted");
  });
}
