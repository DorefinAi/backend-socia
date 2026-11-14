// Breaking compose with handles the desk added (handle_directory, source "desk"): suggested on stories that name
// their keywords, after the files' picks and within their cap. Needs TEST_DATABASE_URL.

import { createDb, handleDirectory, orgs, postDrafts, runMigrations, stories, type DbHandle } from "@socia/db";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phaseOneData } from "../src/data-files";
import { Dictionaries, composeNext } from "../src/stages/compose";

const URL_ = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });
/** The draft's mentions and its suggested handles */
const everyHandle = (d: { mentions: string[]; mentionSuggestions: unknown }) => [...d.mentions, ...((d.mentionSuggestions as { handle: string }[] | null) ?? []).map((m) => m.handle)];

(URL_ ? describe : describe.skip)("breaking compose: desk-added handles", () => {
  let h: DbHandle;
  let orgId: string;
  const data = phaseOneData(log);

  /** A converted breaking story, composed; its draft */
  async function compose(slug: string, headline: string, body: string, district: string | null) {
    const [story] = await h.db.insert(stories).values({ orgId, slug, status: "converted", headline, body, district, layout: "breaking", mediaState: "none" }).returning();
    while (await composeNext(h.db, new Dictionaries(h.db, orgId), log, { cardOnDemand: true, data }));
    const [draft] = await h.db.select().from(postDrafts).where(eq(postDrafts.storyId, story!.id));
    return draft!;
  }

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const now = new Date();
    await h.db.insert(handleDirectory).values([
      { orgId, entityName: "Jhalawar", entityNameHi: "झालावाड़", aliases: ["Jhalawar", "झालावाड़", "झालावाड"], handle: "JhalawarUpdates", source: "desk", verifiedAt: now },
      { orgId, entityName: "Kota", entityNameHi: "कोटा", aliases: ["Kota", "कोटा"], handle: "KotaNewsDesk", source: "desk", verifiedAt: now },
      // No keywords: never suggested
      { orgId, entityName: "RandomGuy123", aliases: [], handle: "RandomGuy123", source: "desk", verifiedAt: now },
      // Added in Settings (desk fixes 14 Nov, point 7): matched on its names and the keywords inside the handle
      { orgId, entityName: "Bundi", aliases: ["Bundi", "बूंदी"], handle: "BundiManual", source: "manual", verifiedAt: now },
      // A Settings row whose handle names nothing: matched on its own names only (Hindi name, an alias)
      { orgId, entityName: "Ramesh Meena", entityNameHi: "रमेश मीणा", aliases: ["रमेश मीणा जी"], handle: "rm_writes", source: "manual", verifiedAt: now },
      // Promoted from staging
      { orgId, entityName: "Sanganer Airport", aliases: ["सांगानेर एयरपोर्ट"], handle: "SanganerAirpt", source: "wikidata:Q1", verifiedAt: now },
      // Settings rows the safety rules hold back: an official's, a lookalike of a file handle; and an unverified one
      { orgId, entityName: "Tonk", entityNameHi: "टोंक", aliases: ["Tonk"], handle: "SPTonkCity", source: "manual", verifiedAt: now },
      { orgId, entityName: "Tonk", entityNameHi: "टोंक", aliases: ["Tonk"], handle: "TonkManualX", source: "manual", verifiedAt: null },
      { orgId, entityName: "Bundi", aliases: ["Bundi", "बूंदी"], handle: "BundiUnverified", source: "desk", verifiedAt: null },
      // Should never have got keywords (set some other way): a party's, an official's, a file handle, a lookalike
      { orgId, entityName: "Kota", aliases: ["Kota", "कोटा"], handle: "BJP4Kota", source: "desk", verifiedAt: now },
      { orgId, entityName: "Kota", aliases: ["Kota", "कोटा"], handle: "SPKotaCity", source: "desk", verifiedAt: now },
      { orgId, entityName: "Jodhpur", aliases: ["Jodhpur", "जोधपुर"], handle: "iitjodhpur", source: "desk", verifiedAt: now },
      { orgId, entityName: "Jhalawar", aliases: ["Jhalawar", "झालावाड़"], handle: "JhalawarPolic", source: "desk", verifiedAt: now },
    ]);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it("suggests the Jhalawar desk handle on a Jhalawar story and puts it in the post", async () => {
    const d = await compose("jhalawar-rain", "झालावाड़ में तेज बारिश से नदी उफान पर", "स्कूलों में छुट्टी घोषित", "Jhalawar");
    expect(d.mentions).toEqual(["@JhalawarUpdates"]);
    // With the rule id and the reason line (reporter-prior contract)
    expect(d.mentionSuggestions).toEqual([{ handleId: "rule:desk:JhalawarUpdates", entity: "Jhalawar", handle: "@JhalawarUpdates", exact: true, source: "desk", reason: "Jhalawar" }]);
  });

  it("does not suggest it on a Kota story; a Settings row is matched, no-keyword and unverified rows never", async () => {
    const kota = await compose("kota-rain", "कोटा में तेज बारिश", "बूंदी में भी असर", "Kota");
    expect(kota.mentions).toEqual(["@KotaNewsDesk", "@BundiManual"]);
    const plain = await compose("random", "RandomGuy123 ने किया पोस्ट", "", "Jaipur");
    expect(plain.mentions).toEqual([]);
  });

  it("matches a Settings or promoted row on its Hindi name and aliases; never an official's or an unverified one", async () => {
    const person = await compose("rm-visit", "रमेश मीणा ने किया दौरा", "", "Jaipur");
    expect(everyHandle(person)).toContain("@rm_writes");
    const airport = await compose("airport", "सांगानेर एयरपोर्ट पर नई उड़ान", "", "Jaipur");
    expect(everyHandle(airport)).toContain("@SanganerAirpt");
    const tonk = await compose("tonk-fair", "टोंक में मेला शुरू", "", "Tonk");
    expect(everyHandle(tonk)).not.toContain("@SPTonkCity");
    expect(everyHandle(tonk)).not.toContain("@TonkManualX");
  });

  it("never suggests a party's or an official's desk row, a file handle or a lookalike of one", async () => {
    const jodhpur = await compose("jodhpur-rain", "जोधपुर में तेज बारिश", "", "Jodhpur");
    expect(jodhpur.mentions).toEqual([]);
    const kota = await compose("kota-fair", "कोटा में दशहरा मेला शुरू", "", "Kota");
    expect(kota.mentions).toEqual(["@KotaNewsDesk"]); // not @BJP4Kota, not @SPKotaCity
    const jhalawar = await compose("jhalawar-fair", "झालावाड़ में मेला", "", "Jhalawar");
    expect(jhalawar.mentions).toEqual(["@JhalawarUpdates"]); // not @JhalawarPolic
  });

  it("keeps desk rows out of the non-breaking composer; a manual directory row is still suggested there", async () => {
    const [story] = await h.db.insert(stories).values({ orgId, slug: "plain-rain", status: "converted", headline: "झालावाड़ और बूंदी में बारिश", body: "", mediaState: "none" }).returning();
    while (await composeNext(h.db, new Dictionaries(h.db, orgId), log, { cardOnDemand: true, data }));
    const [draft] = await h.db.select().from(postDrafts).where(eq(postDrafts.storyId, story!.id));
    const suggested = (draft!.mentionSuggestions as { handle: string }[]).map((m) => m.handle);
    expect(suggested).toContain("@BundiManual");
    expect(suggested).not.toContain("@JhalawarUpdates");
  });

  it("keeps the cap of 3 with the files' picks first", async () => {
    const d = await compose("cm-jhalawar", "मुख्यमंत्री भजनलाल शर्मा ने झालावाड़ और कोटा में किया लोकार्पण", "", "Jhalawar");
    expect(d.mentions).toHaveLength(3);
    expect(d.mentions[0]).toBe("@BhajanlalBjp");
    expect(d.mentions[1]).toBe("@JhalawarUpdates");
    expect(d.mentions[2]).toBe("@KotaNewsDesk");
  });
});
