// Breaking compose with handles the desk added (handle_directory, source "desk"): suggested on stories that name
// their keywords, after the files' picks and within their cap. Needs TEST_DATABASE_URL.

import { createDb, handleDirectory, orgs, postDrafts, publishedPosts, runMigrations, stories, type DbHandle } from "@socia/db";
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
      // Added in Settings (handle fixes F1): typed, matched on its own names and keywords only, suggest-only until posted twice
      { orgId, entityName: "Bundi", aliases: ["Bundi", "बूंदी"], handle: "BundiManual", source: "manual", entityType: "organisation", verifiedAt: now },
      // A Settings person: matched on its own names only (Hindi name, an alias)
      { orgId, entityName: "Ramesh Meena", entityNameHi: "रमेश मीणा", aliases: ["रमेश मीणा जी"], handle: "rm_writes", source: "manual", entityType: "person", verifiedAt: now },
      // Promoted from staging
      { orgId, entityName: "Sanganer Airport", aliases: ["सांगानेर एयरपोर्ट"], handle: "SanganerAirpt", source: "wikidata:Q1", entityType: "organisation", verifiedAt: now },
      // F1: @JaipurMetro never rides on a #Jaipur story by the district; posted twice (below) it is tagged on a metro story
      { orgId, entityName: "Jaipur Metro Rail", aliases: ["मेट्रो", "Metro", "जयपुर मेट्रो"], handle: "JaipurMetro", source: "manual", entityType: "organisation", verifiedAt: now },
      // A Settings police handle (matched by its district, offered); a lookalike of a file handle; an unverified row
      { orgId, entityName: "Tonk", entityNameHi: "टोंक", aliases: ["Tonk"], handle: "SPTonkCity", source: "manual", entityType: "police", verifiedAt: now },
      { orgId, entityName: "Jhalawar", aliases: ["झालावाड़"], handle: "JhalawarPolic", source: "manual", entityType: "police", verifiedAt: now },
      { orgId, entityName: "Tonk", entityNameHi: "टोंक", aliases: ["Tonk"], handle: "TonkManualX", source: "manual", entityType: "organisation", verifiedAt: null },
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

  it("does not suggest it on a Kota story; a Settings row is offered (not posted yet), no-keyword and unverified rows never", async () => {
    const kota = await compose("kota-rain", "कोटा में तेज बारिश", "बूंदी में भी असर", "Kota");
    expect(kota.mentions).toEqual(["@KotaNewsDesk"]);
    expect(everyHandle(kota)).toContain("@BundiManual");
    const plain = await compose("random", "RandomGuy123 ने किया पोस्ट", "", "Jaipur");
    expect(plain.mentions).toEqual([]);
  });

  it("matches a Settings or promoted row on its Hindi name and aliases (offered); a police row by its district; never a lookalike or an unverified one", async () => {
    const person = await compose("rm-visit", "रमेश मीणा ने किया दौरा", "", "Jaipur");
    expect(everyHandle(person)).toContain("@rm_writes");
    const airport = await compose("airport", "सांगानेर एयरपोर्ट पर नई उड़ान", "", "Jaipur");
    expect(everyHandle(airport)).toContain("@SanganerAirpt");
    expect(person.mentions).not.toContain("@rm_writes");
    const tonk = await compose("tonk-fair", "टोंक में मेला शुरू", "", "Tonk");
    expect(tonk.mentions).not.toContain("@SPTonkCity");
    expect(everyHandle(tonk)).toContain("@SPTonkCity");
    expect(everyHandle(tonk)).not.toContain("@TonkManualX");
    const jhalawar = await compose("jhalawar-crash", "झालावाड़ में ट्रक की टक्कर से युवक की मौत", "", "Jhalawar");
    expect(everyHandle(jhalawar)).not.toContain("@JhalawarPolic");
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

  it("F1: @JaipurMetro is never on a #Jaipur story without a metro word; offered on a metro story; tagged once posted twice", async () => {
    const rain = await compose("jaipur-rain", "जयपुर में तेज बारिश, सड़कों पर जलभराव", "", "Jaipur");
    expect(everyHandle(rain)).not.toContain("@JaipurMetro");
    const fare = await compose("metro-fare", "जयपुर मेट्रो का किराया बढ़ा, यात्रियों में नाराजगी", "", "Jaipur");
    expect(fare.mentions).not.toContain("@JaipurMetro");
    expect(everyHandle(fare)).toContain("@JaipurMetro");
    // The desk posts it twice (Copy & Posted): the posted-use count takes it out of suggest-only
    await h.db.insert(publishedPosts).values([
      { orgId, draftId: rain.id, platform: "x", text: "#Jaipur: जयपुर मेट्रो फेज 2\n\n#RajasthanWithFirstIndia @JaipurMetro" },
      { orgId, draftId: fare.id, platform: "x", text: "#Jaipur: मेट्रो में भीड़ @jaipurmetro" },
    ]);
    const again = await compose("metro-fare-2", "जयपुर मेट्रो का किराया बढ़ा, यात्रियों में नाराजगी", "", "Jaipur");
    expect(again.mentions).toContain("@JaipurMetro");
    const rainAgain = await compose("jaipur-rain-2", "जयपुर में तेज बारिश, सड़कों पर जलभराव", "", "Jaipur");
    expect(everyHandle(rainAgain)).not.toContain("@JaipurMetro");
  });

  it("keeps the cap of 3 with the files' picks first", async () => {
    const d = await compose("cm-jhalawar", "मुख्यमंत्री भजनलाल शर्मा ने झालावाड़ और कोटा में किया लोकार्पण", "", "Jhalawar");
    expect(d.mentions).toHaveLength(3);
    expect(d.mentions[0]).toBe("@BhajanlalBjp");
    expect(d.mentions[1]).toBe("@JhalawarUpdates");
    expect(d.mentions[2]).toBe("@KotaNewsDesk");
  });
});
