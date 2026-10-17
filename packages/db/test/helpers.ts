// Integration tests need a real Postgres: set TEST_DATABASE_URL (the database is wiped).
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/client";
import { runMigrations } from "../src/migrate";
import { ingestedFiles, orgs, postDrafts, stories, users } from "../src/schema";
import type { Actor } from "../src/desk";

export const TEST_URL = process.env.TEST_DATABASE_URL;

export async function freshDb(): Promise<DbHandle> {
  const handle = createDb(TEST_URL!, 5);
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
  await runMigrations(TEST_URL!);
  return handle;
}

export async function seed(handle: DbHandle) {
  const { db } = handle;
  const [org] = await db
    .insert(orgs)
    .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: ["#1stIndiaNews"], maxHashtags: 4, dailyCaps: { x: 2 }, headlineWords: 9 } })
    .returning();
  const mk = async (name: string, role: Actor["role"]) => {
    const [u] = await db.insert(users).values({ orgId: org!.id, name, email: `${name.toLowerCase()}@test`, passwordHash: "x", role }).returning();
    return { id: u!.id, orgId: org!.id, name, role } satisfies Actor;
  };
  const priya = await mk("Priya", "operator");
  const amit = await mk("Amit", "operator");

  async function draft(headline = "जयपुर मेट्रो फेज-2 को मंजूरी", rendered = true) {
    const [file] = await db
      .insert(ingestedFiles)
      .values({ orgId: org!.id, sha256: crypto.randomUUID(), sourcePath: "/x.txt", fileName: "x.txt", bytes: 10, storageKey: "raw/x", kind: "text", slug: "x" })
      .returning();
    const [story] = await db.insert(stories).values({ orgId: org!.id, fileId: file!.id, slug: "x", status: "composed", headline, body: "" }).returning();
    const [d] = await db
      .insert(postDrafts)
      .values({
        orgId: org!.id, storyId: story!.id, status: rendered ? "ready" : "rendering", bodyText: headline, cardHeadline: headline,
        hashtags: ["#Jaipur"], composeVersion: "test", cardRenderedRev: rendered ? 1 : 0, cardKey: rendered ? "cards/x.png" : null,
        mentionSuggestions: [{ handleId: "h", entity: "JDA", handle: "@JDAJaipur", exact: true }],
      })
      .returning();
    return d!;
  }

  return { org: org!, priya, amit, draft };
}
