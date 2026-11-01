// Who may read a LocalStorage file at /dev-files (development and the office PC; production uses signed R2
// links). The link itself is permanent and unsigned, so the route asks for a signed-in session and serves a
// key only to the org it belongs to. Keys are made server-side; each prefix has one owner rule:
//   card-templates/org/<orgId>/...  org card designs: the org id is in the key
//   card-templates/<userId>/...     a user's own card background: the card_templates row of that org
//   cards/...                        rendered / uploaded cards: a draft or post of that org names the key
//   raw/...                          ingested files: an ingested_files or assets row of that org names the key
//   media/...                        Samvadia footage copies: an assets row of that org names the key
// Anything else (trend-images/ is served only by /trends/:id/image) is not served here.

import { assets, cardTemplates, ingestedFiles, postDrafts, publishedPosts, type Db } from "@socia/db";
import { and, eq, or, sql } from "drizzle-orm";

/** True when `key` is a stored file of org `orgId` */
export async function orgOwnsKey(db: Db, orgId: string, key: string): Promise<boolean> {
  const parts = key.split("/");
  // Stored keys are plain "a/b/c": no "." / ".." / empty segments and no backslash (a separator on Windows),
  // which could otherwise walk from an allowed prefix into another org's folder. Windows also trims a trailing
  // dot or space and reads ":" as a drive or stream, so those are refused too
  if (parts.some((p) => p === "" || p === "." || p === ".." || /[. ]$/.test(p)) || /[\\\0:]/.test(key)) return false;
  const [head, second, third] = parts;
  const one = { one: sql`1` };
  const any = async (q: Promise<unknown[]>) => (await q).length > 0;
  switch (head) {
    case "card-templates":
      if (second === "org") return third === orgId;
      return any(db.select(one).from(cardTemplates).where(and(eq(cardTemplates.orgId, orgId), eq(cardTemplates.backgroundKey, key))).limit(1));
    case "cards":
      return (
        (await any(db.select(one).from(postDrafts).where(and(eq(postDrafts.orgId, orgId), or(eq(postDrafts.cardKey, key), eq(postDrafts.customCardKey, key)))).limit(1))) ||
        any(db.select(one).from(publishedPosts).where(and(eq(publishedPosts.orgId, orgId), eq(publishedPosts.cardKey, key))).limit(1))
      );
    case "raw":
      return (
        (await any(db.select(one).from(ingestedFiles).where(and(eq(ingestedFiles.orgId, orgId), eq(ingestedFiles.storageKey, key))).limit(1))) ||
        any(db.select(one).from(assets).where(and(eq(assets.orgId, orgId), eq(assets.storageKey, key))).limit(1))
      );
    case "media":
      return any(db.select(one).from(assets).where(and(eq(assets.orgId, orgId), eq(assets.storageKey, key))).limit(1));
    default:
      return false;
  }
}
