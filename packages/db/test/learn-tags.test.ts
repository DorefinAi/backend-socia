// The desk's handle and hashtag library learns at the moment a breaking post goes out (src/learn.ts).
// Needs TEST_DATABASE_URL (the database is wiped).

import { readFileSync } from "node:fs";
import { PlaceBook, PostedLearner, deskKeywordAuto, deskKeywordOffered, districtKeywordCandidates, parseHandleRules, parsePlacesData, parseSubjectHandles, withKeywordUses } from "@socia/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { deskSuggestionStats, dictionaryFingerprint, handlePostedStories } from "../src/composer";
import { recordProposal } from "../src/decisions";
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
      desk("JaipurLocalNews"), desk("JaipurBuzz"), desk("NitinNabin"), desk("jaipur_police"), desk("somereporter"),
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

  /**
   * A breaking draft (footer-only: it has a handle_pick) on a story, with the desk's handles and tags, and its decision
   * log proposal; `emitted` are handles the composer put on it (handle_pick and the proposal), so not the desk's
   */
  async function breaking(headline: string, body: string, district: string | null, mentions: string[], hashtags: string[], suggestions: string[] = [], opts: { town?: string; emitted?: string[] } = {}) {
    const d = await s.draft(headline);
    await h.db.update(stories).set({ body, district, town: opts.town ?? null }).where(eq(stories.id, d.storyId));
    const emitted = opts.emitted ?? [];
    const [updated] = await h.db
      .update(postDrafts)
      .set({ handlePick: { cls: "other", why: "", warnings: [], handles: emitted.map((handle) => ({ handle, reason: "desk" as const })) }, mentions, hashtags, hashtagSuggestions: suggestions })
      .where(eq(postDrafts.id, d.id))
      .returning();
    await recordProposal(h.db, { orgId: s.org.id, draftId: d.id }, {
      orgId: s.org.id, draftId: d.id, storyId: d.storyId, filenameRaw: null, slotRaw: null, reporterToken: null, bureauCode: null, bureauDistrict: null, reporterHandle: null,
      reporterStatus: "no_filename", storyClass: "other", district, districtFrom: null, composeVersion: "test", draftText: headline, explore: false,
      proposals: emitted.map((item) => ({ item, kind: "handle" as const, layer: "emit" as const, source: "desk", reason: "test" })),
    });
    return updated!;
  }

  it("a desk handle the desk typed learns its own district's names on Copy & Posted; an emitted one, a person's, file and reporter handles learn nothing", async () => {
    const before = await dictionaryFingerprint(h.db, s.org.id);
    const d = await breaking(
      "चाकसू में सड़क हादसा", "जयपुर जिले के चाकसू में, दिल्ली से आई टीम", "Jaipur", ["@JaipurLocalNews", "@JaipurBuzz", "@NitinNabin", "@jaipur_police", "@somereporter"], ["#RajasthanWithFirstIndia"], [],
      { town: "चाकसू", emitted: ["@JaipurBuzz"] },
    );
    await copyPosted(h.db, s.priya, d.id, d.version, { learner });

    const chaksu = await row("JaipurLocalNews");
    expect(chaksu.aliases).toEqual(["Jaipur", "जयपुर", "चाकसू"]);
    expect(chaksu.verifiedAt!.getTime()).toBeGreaterThan(new Date("2026-11-01").getTime());
    // The composer put @JaipurBuzz on the post: not the desk's choice, nothing learned (the old loop fed on these)
    expect((await row("JaipurBuzz")).aliases).toEqual([]);
    // A person's handle has no district of its own: never a place
    expect((await row("NitinNabin")).aliases).toEqual([]);
    expect((await row("jaipur_police")).aliases).toEqual([]);
    expect((await row("somereporter")).aliases).toEqual([]);
    expect((await row("@somereporter", "reporter")).aliases).toEqual(["SOMEREP"]);
    const [a] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "handle.keywords_learned"), eq(auditLog.entityId, chaksu.id)));
    expect(a).toMatchObject({ actorId: s.priya.id, before: { aliases: [] }, after: { added: ["Jaipur", "जयपुर", "चाकसू"], draftId: d.id } });
    // The worker reloads its rows: the fingerprint changed
    expect(await dictionaryFingerprint(h.db, s.org.id)).not.toBe(before);
  });

  it("only desk-typed posts are evidence: a second one offers the learned town; a place is never added on its own", async () => {
    const d = await breaking("चाकसू में मेला", "", "Jaipur", ["@JaipurLocalNews", "@JaipurBuzz"], [], [], { town: "चाकसू", emitted: ["@JaipurBuzz"] });
    const claimed = await claimDraft(h.db, s.priya, d.id);
    await markPosted(h.db, s.priya, d.id, claimed.version, { platformPostId: `p-${d.id}`, permalink: "https://x.com/a/status/2" }, { learner });
    // Learning found nothing new; the keywords stay
    expect((await row("JaipurLocalNews")).aliases).toEqual(["Jaipur", "जयपुर", "चाकसू"]);
    const posted = await handlePostedStories(h.db, s.org.id, ["@JaipurLocalNews", "@JaipurBuzz"]);
    expect(posted.get("jaipurlocalnews")).toHaveLength(2);
    // Emitted on both posts, typed on none: no evidence at all
    expect(posted.get("jaipurbuzz")).toHaveLength(0);
    const r = withKeywordUses({ handle: "JaipurLocalNews", entityName: "JaipurLocalNews", aliases: (await row("JaipurLocalNews")).aliases }, posted.get("jaipurlocalnews")!, districtKeywordCandidates());
    // Jaipur is in the handle string: added from the start; the town is offered (two desk-typed stories), never added
    expect(r.aliases.map((k) => [k, deskKeywordAuto(r, k), deskKeywordOffered(r, k)])).toEqual([["Jaipur", true, true], ["जयपुर", true, true], ["चाकसू", false, true]]);
    // Nobody was offered this handle as a suggestion
    expect(Object.fromEntries(await deskSuggestionStats(h.db, s.org.id, ["@JaipurLocalNews"]))).toEqual({ jaipurlocalnews: { offered: 0, accepted: 0 } });
  });

  it("typed hashtags become topic rules at once (an unknown one off until its 2nd story); footer, offered and an editor's own tags do not", async () => {
    const before = await dictionaryFingerprint(h.db, s.org.id);
    const d = await breaking("जैसलमेर में चुनाव", "", "Jaisalmer", [], ["#RajasthanWithFirstIndia", "#Jaisalmer", "#JaswantYadav", "#jaipur", "#BombThreat", "#RajasthanWithFirstIndiaJaipurPolice", "#Balotrapolice"], ["#BombThreat"]);
    await copyPosted(h.db, s.priya, d.id, d.version, { learner });
    // A story naming nothing known, and a tag too short to be a word: nothing to match on
    const bare = await breaking("तेज बारिश से नदी उफान पर", "", null, [], ["#RCA"]);
    await copyPosted(h.db, s.priya, bare.id, bare.version, { learner });

    expect(await rule("Jaisalmer")).toMatchObject({ matchType: "entity", name: "Jaisalmer", aliases: ["जैसलमेर"], active: true, priority: 1 });
    // A tag naming no known place or subject is saved with its own words (never the story's places) but offered only
    // from its second story
    expect(await rule("JaswantYadav")).toMatchObject({ name: "Jaswant", aliases: ["Yadav"], active: false });
    expect(await rule("RCA")).toMatchObject({ name: "RCA", aliases: [], active: false });
    // The editor's Jaipur rule is the only one for #jaipur; nothing for the footer run-on, the offered tag, or a
    // handle typed with a # (#Balotrapolice for @BalotraPolice)
    expect(await h.db.select().from(hashtagRules).where(eq(hashtagRules.hashtagLatin, "jaipur"))).toEqual([]);
    expect(await rule("RajasthanWithFirstIndiaJaipurPolice")).toBeUndefined();
    expect(await rule("Balotrapolice")).toBeUndefined();
    expect((await h.db.select().from(hashtagRules).where(eq(hashtagRules.hashtagLatin, "BombThreat")))).toHaveLength(1);

    // Staging is still written, and marks the rows that became rules
    const staged = Object.fromEntries((await h.db.select().from(hashtagStaging)).map((r) => [r.tagKey, r.promotedAt !== null]));
    expect(staged).toMatchObject({ jaisalmer: true, jaswantyadav: true, rca: true, jaipur: false, balotrapolice: false });
    const learned = await h.db.select().from(auditLog).where(eq(auditLog.action, "hashtag.rule_learned"));
    expect(learned).toHaveLength(3);
    expect(await dictionaryFingerprint(h.db, s.org.id)).not.toBe(before);
  });

  it("a learned rule never takes a later story's places; an inactive one wakes up; an editor's change is never undone", async () => {
    const d = await breaking("जयपुर में क्रिकेट", "", "Jaipur", [], ["#RCA", "#JaswantYadav"]);
    await copyPosted(h.db, s.priya, d.id, d.version, { learner });
    // Still nothing of its own to match on: stays off, and never learns Jaipur from the story
    expect(await rule("RCA")).toMatchObject({ name: "RCA", aliases: [], active: false });
    // Its second story: now offered, with its own words only
    expect(await rule("JaswantYadav")).toMatchObject({ name: "Jaswant", aliases: ["Yadav"], active: true });

    // An editor edits the Jaisalmer rule in Settings: from then on it is theirs
    const jaisalmer = (await rule("Jaisalmer"))!;
    await audit(h.db, { orgId: s.org.id, actorId: s.amit.id, action: "hashtag_rule.update", entityType: "hashtag_rule", entityId: jaisalmer.id });
    await h.db.update(hashtagRules).set({ aliases: [] }).where(eq(hashtagRules.id, jaisalmer.id));
    const again = await breaking("कोटा में बारिश", "", "Kota", [], ["#Jaisalmer"]);
    await copyPosted(h.db, s.priya, again.id, again.version, { learner });
    expect((await rule("Jaisalmer"))!.aliases).toEqual([]);
  });

  it("learns nothing without a learner (no data files) and nothing from an edit while typing", async () => {
    const d = await breaking("चाकसू में बारिश", "", "Kota", ["@JaipurLocalNews"], ["#Unlearned"]);
    const claimed = await claimDraft(h.db, s.priya, d.id);
    await updateDraft(h.db, s.priya, d.id, claimed.version, { hashtags: ["#AlsoUnlearned"] });
    expect(await rule("AlsoUnlearned")).toBeUndefined();
    const fresh = (await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id)))[0]!;
    await copyPosted(h.db, s.priya, d.id, fresh.version);
    expect(await rule("AlsoUnlearned")).toBeUndefined();
    expect((await row("JaipurLocalNews")).aliases).not.toContain("Kota");
    // The staging still ran
    expect((await h.db.select().from(hashtagStaging).where(eq(hashtagStaging.tagKey, "alsounlearned")))).toHaveLength(1);
  });
});
