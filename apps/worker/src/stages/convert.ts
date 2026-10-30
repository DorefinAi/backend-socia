// Convert + parse: Kruti Dev → Unicode, then line 1 = headline. Nothing downstream can be trusted
// until the converter passes the regression set with the control room's real font (doc §11 step 0).

import { SERIOUS_CHECKS, STICKY_CHECKS, conversionConfidence, decodeBytes, detectEncoding, krutiToUnicode, parseBreaking, parseStory, type BreakingStory } from "@socia/core";
import { ingestedFiles, stories, type Db } from "@socia/db";
import type { Storage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
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
  no_headline: "No headline line was found.",
  no_hindi: "The file has no Hindi text; check the encoding.",
  very_long: "The file is much longer than a breaking item.",
  no_district: "No district was found in the place line, the file name or the text.",
  desk_note: "A desk instruction (नोट) was taken out of the text.",
};

/** A breaking file's fields on stories (phase 1 layout) */
export function breakingColumns(b: BreakingStory, sticky: string[] = []) {
  const serious = b.needsCheck.some((c) => SERIOUS_CHECKS.includes(c));
  const needsCheck: string[] = [...b.needsCheck, ...sticky.filter((c) => !(b.needsCheck as string[]).includes(c))];
  return {
    headline: b.headline,
    body: b.points.join("\n"),
    district: b.district,
    town: b.town,
    fileTags: b.tags,
    needsCheck,
    deskNote: b.deskNote,
    parseMethod: serious ? "needs_review" : "breaking",
    parseNote: needsCheck.map((c) => CHECK_NOTES[c]).filter(Boolean).join(" ") || null,
  };
}

export async function convertNext(db: Db, storage: Storage, log: Logger, data?: PhaseOneData): Promise<boolean> {
  return nextStoryIsolated(db, "ingested", log, "convert", async (tx, story) => {
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
      // Breaking files are UTF-8 Unicode: no Kruti Dev guess (a Latin file-name line can look like Kruti Dev)
      const { text, charset } = decodeBytes(bytes);
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
      log.info({ storyId: story.id, district: b.district, town: b.town, checks: b.needsCheck }, failed ? "breaking file could not be parsed" : "breaking file converted");
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
