// Convert + parse: Kruti Dev → Unicode, then line 1 = headline. Nothing downstream can be trusted
// until the converter passes the regression set with the control room's real font (doc §11 step 0).

import { conversionConfidence, decodeBytes, detectEncoding, krutiToUnicode, parseStory } from "@socia/core";
import { ingestedFiles, stories, withNextStory, type Db } from "@socia/db";
import type { Storage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";

export function convertText(bytes: Uint8Array) {
  const { text, charset } = decodeBytes(bytes);
  const encoding = detectEncoding(text);
  const unicode = encoding === "krutidev" ? krutiToUnicode(text) : text.normalize("NFC");
  return { sourceText: text, charset, encoding, unicode, confidence: conversionConfidence(unicode), parsed: parseStory(unicode) };
}

export async function convertNext(db: Db, storage: Storage, log: Logger): Promise<boolean> {
  return withNextStory(db, "ingested", async (tx, story) => {
    const [file] = await tx.select().from(ingestedFiles).where(eq(ingestedFiles.id, story.fileId));
    const result = convertText(await storage.get(file!.storageKey));
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
