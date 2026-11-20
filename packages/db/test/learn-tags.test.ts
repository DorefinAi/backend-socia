// The desk's handle and hashtag library learns at the moment a breaking post goes out (src/learn.ts).
// Needs TEST_DATABASE_URL (the database is wiped).

import { readFileSync } from "node:fs";
import { PlaceBook, PostedLearner, deskKeywordAuto, districtKeywordCandidates, parseHandleRules, parsePlacesData, parseSubjectHandles, withKeywordUses } from "@socia/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { dictionaryFingerprint, handlePostedStories } from "../src/composer";
import { copyPosted, markPosted, updateDraft, claimDraft } from "../src/desk";
import { audit } from "../src/audit";
import { auditLog, handleDirectory, hashtagRules, hashtagStaging, postDrafts, stories } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";

const run = TEST_URL ? describe : describe.skip;
const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

run("learning from posted breaking stories", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;
  const subjects = parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"));
  const learner = new PostedLearner({
    book: new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json"))),
    subjects,
    fileHandles: [...(parseHandleRules(json("../../../apps/worker/config/district-handles.json")).all ?? []), ...(subjects.handles ?? []), "somereporter"],
  });

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
    const desk = (handle: string) => ({ orgId: s.org.id, entityName: handle, aliases: [], handle, source: "desk", verifiedAt: new Date("2026-11-01"), verifiedBy: s.priya.id });
    await h.db.insert(handleDirectory).values([
      desk("ChaksuNews"), desk("jaipur_police"), desk("somereporter"),
      { orgId: s.org.id, entityName: "somereporter", aliases: ["SOMEREP"], handle: "@somereporter", source: "reporter", verifiedAt: new Date("2026-11-01") },
    ]);
    // An editor's own rules: one place rule, one topic rule (the second offered on the story below)
    await h.db.insert(hashtagRules).values([
      { orgId: s.org.id, matchType: "district", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 5 },
      { orgId: s.org.id, matchType: "entity", name: "बम की धमकी", aliases: [], hashtagLatin: "BombThreat", priority: 8 },
    ]);
  }, 60_000);
  afterAll(async () => h?.close());

  const row = async (handle: string, source = "desk") =>
    (await h.db.select().from(handleDirectory).where(and(eq(handleDirectory.handle, handle), eq(handleDirectory.source, source))))[0]!;
  const rule = async (latin: string) => (await h.db.select().from(hashtagRules).where(eq(hashtagRules.hashtagLatin, latin)))[0];

  /** A breaking draft (footer-only: it has a handle_pick) on a story, with the desk's handles and tags */
  async function breaking(headline: string, body: string, district: string | null, mentions: string[], hashtags: string[], suggestions: string[] = []) {
    const d = await s.draft(headline);
    await h.db.update(stories).set({ body, district }).where(eq(stories.id, d.storyId));
    const [updated] = await h.db
      .update(postDrafts)
      .set({ handlePick: { cls: "other", why: "", warnings: [], handles: [] }, mentions, hashtags, hashtagSuggestions: suggestions })
      .where(eq(postDrafts.id, d.id))
      .returning();
    return updated!;
  }

  it("a desk handle learns the story's recognised names on Copy & Posted; file and reporter handles learn nothing", async () => {
    const before = await dictionaryFingerprint(h.db, s.org.id);
    const d = await breaking("चाकसू में सड़क हादसा", "जयपुर जिले के चाकसू में", "Jaipur", ["@ChaksuNews", "@jaipur_police", "@somereporter"], ["#RajasthanWithFirstIndia"]);
    await copyPosted(h.db, s.priya, d.id, d.version, { learner });

    const chaksu = await row("ChaksuNews");
    expect(chaksu.aliases).toEqual(["Jaipur", "जयपुर", "चाकसू"]);
    expect(chaksu.verifiedAt!.getTime()).toBeGreaterThan(new Date("2026-11-01").getTime());
    expect((await row("jaipur_police")).aliases).toEqual([]);
    expect((await row("somereporter")).aliases).toEqual([]);
    expect((await row("@somereporter", "reporter")).aliases).toEqual(["SOMEREP"]);
    const [a] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "handle.keywords_learned"), eq(auditLog.entityId, chaksu.id)));
    expect(a).toMatchObject({ actorId: s.priya.id, before: { aliases: [] }, after: { added: ["Jaipur", "जयपुर", "चाकसू"], draftId: d.id } });
    // The worker reloads its rows: the fingerprint changed
    expect(await dictionaryFingerprint(h.db, s.org.id)).not.toBe(before);
  });

  it("after a second posted story naming a keyword, that keyword is added on its own (the worker's count)", async () => {
    const d = await breaking("चाकसू में मेला", "", null, ["@ChaksuNews"], []);
    const claimed = await claimDraft(h.db, s.priya, d.id);
    await markPosted(h.db, s.priya, d.id, claimed.version, { platformPostId: `p-${d.id}`, permalink: "https://x.com/a/status/2" }, { learner });
    // Learning found nothing new; the keywords stay
    expect((await row("ChaksuNews")).aliases).toEqual(["Jaipur", "जयपुर", "चाकसू"]);
    const posted = await handlePostedStories(h.db, s.org.id, ["@ChaksuNews"]);
    expect(posted.get("chaksunews")).toHaveLength(2);
    const r = withKeywordUses({ handle: "ChaksuNews", entityName: "ChaksuNews", aliases: (await row("ChaksuNews")).aliases }, posted.get("chaksunews")!, districtKeywordCandidates());
    expect(r.aliases.map((k) => [k, deskKeywordAuto(r, k)])).toEqual([["Jaipur", false], ["जयपुर", false], ["चाकसू", true]]);
  });

  it("typed hashtags become topic rules at once (an unknown one off until its 2nd story); footer, offered and an editor's own tags do not", async () => {
    const before = await dictionaryFingerprint(h.db, s.org.id);
    const d = await breaking("जैसलमेर में चुनाव", "", "Jaisalmer", [], ["#RajasthanWithFirstIndia", "#Jaisalmer", "#JaswantYadav", "#jaipur", "#BombThreat", "#RajasthanWithFirstIndiaJaipurPolice"], ["#BombThreat"]);
    await copyPosted(h.db, s.priya, d.id, d.version, { learner });
    // A story naming nothing known, and a tag too short to be a word: nothing to match on
    const bare = await breaking("तेज बारिश से नदी उफान पर", "", null, [], ["#RCA"]);
    await copyPosted(h.db, s.priya, bare.id, bare.version, { learner });

    expect(await rule("Jaisalmer")).toMatchObject({ matchType: "entity", name: "Jaisalmer", aliases: ["जैसलमेर"], active: true, priority: 1 });
    // A tag naming no known place or subject is saved with its keywords but offered only from its second story
    expect(await rule("JaswantYadav")).toMatchObject({ name: "Jaisalmer", aliases: ["जैसलमेर", "Jaswant", "Yadav"], active: false });
    expect(await rule("RCA")).toMatchObject({ name: "RCA", aliases: [], active: false });
    // The editor's Jaipur rule is the only one for #jaipur; nothing for the footer run-on or the offered tag
    expect(await h.db.select().from(hashtagRules).where(eq(hashtagRules.hashtagLatin, "jaipur"))).toEqual([]);
    expect(await rule("RajasthanWithFirstIndiaJaipurPolice")).toBeUndefined();
    expect((await h.db.select().from(hashtagRules).where(eq(hashtagRules.hashtagLatin, "BombThreat")))).toHaveLength(1);

    // Staging is still written, and marks the rows that became rules
    const staged = Object.fromEntries((await h.db.select().from(hashtagStaging)).map((r) => [r.tagKey, r.promotedAt !== null]));
    expect(staged).toMatchObject({ jaisalmer: true, jaswantyadav: true, rca: true, jaipur: false });
    const learned = await h.db.select().from(auditLog).where(eq(auditLog.action, "hashtag.rule_learned"));
    expect(learned).toHaveLength(3);
    expect(await dictionaryFingerprint(h.db, s.org.id)).not.toBe(before);
  });

  it("a learned rule grows with later posts and an inactive one wakes up; an editor's change is never undone", async () => {
    const d = await breaking("जयपुर में क्रिकेट", "", "Jaipur", [], ["#RCA", "#JaswantYadav"]);
    await copyPosted(h.db, s.priya, d.id, d.version, { learner });
    expect(await rule("RCA")).toMatchObject({ name: "Jaipur", aliases: ["जयपुर"], active: true });
    // Its second story: now offered
    expect(await rule("JaswantYadav")).toMatchObject({ aliases: ["जैसलमेर", "Jaswant", "Yadav", "Jaipur", "जयपुर"], active: true });

    // An editor edits the Jaisalmer rule in Settings: from then on it is theirs
    const jaisalmer = (await rule("Jaisalmer"))!;
    await audit(h.db, { orgId: s.org.id, actorId: s.amit.id, action: "hashtag_rule.update", entityType: "hashtag_rule", entityId: jaisalmer.id });
    await h.db.update(hashtagRules).set({ aliases: [] }).where(eq(hashtagRules.id, jaisalmer.id));
    const again = await breaking("कोटा में बारिश", "", "Kota", [], ["#Jaisalmer"]);
    await copyPosted(h.db, s.priya, again.id, again.version, { learner });
    expect((await rule("Jaisalmer"))!.aliases).toEqual([]);
  });

  it("learns nothing without a learner (no data files) and nothing from an edit while typing", async () => {
    const d = await breaking("चाकसू में बारिश", "", "Kota", ["@ChaksuNews"], ["#Unlearned"]);
    const claimed = await claimDraft(h.db, s.priya, d.id);
    await updateDraft(h.db, s.priya, d.id, claimed.version, { hashtags: ["#AlsoUnlearned"] });
    expect(await rule("AlsoUnlearned")).toBeUndefined();
    const fresh = (await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id)))[0]!;
    await copyPosted(h.db, s.priya, d.id, fresh.version);
    expect(await rule("AlsoUnlearned")).toBeUndefined();
    expect((await row("ChaksuNews")).aliases).not.toContain("Kota");
    // The staging still ran
    expect((await h.db.select().from(hashtagStaging).where(eq(hashtagStaging.tagKey, "alsounlearned")))).toHaveLength(1);
  });
});
