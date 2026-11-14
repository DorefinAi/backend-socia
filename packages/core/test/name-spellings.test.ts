// Handle fixes, section 3 (14 Nov 2026): the person handles' name spellings in subject-handles.json and
// party-handles.json. The data test needs the 8 days' exports (day-replay.ts: REPLAY_DAYS or REPLAY_EXPORTS_DIR) and is
// SKIPPED, with the reason in its name, without them; the rest runs anywhere.

import { describe, expect, it } from "vitest";
import { Gazetteer } from "../src/gazetteer";
import { parsePartyHandles, parseSubjectHandles } from "../src";
import { dayExports } from "./day-replay";
import { exportPosts, nameSpellings, personEntries, type PersonEntry } from "./name-spellings";

const HANDLE = /@\w{1,15}/g;
/** Whether the entry's names alone (whole words, folded, as the matchers read them) match the text */
const fires = (e: PersonEntry, text: string) =>
  new Gazetteer([{ id: e.handle, name: e.names[0]!, aliases: e.names.slice(1), priority: 0, data: null }]).find(text.replace(HANDLE, " ")).length > 0;

describe("Hindi names: every person handle with 2+ posts fires on its own posts from its name alone", () => {
  const all = dayExports().every((d) => d.present);
  if (!all) {
    it.skip("SKIPPED — the 8 days' exports are not all present (see day-replay.ts)", () => undefined);
    return;
  }
  const posts = exportPosts();
  const entries = personEntries();
  /**
   * The one handle the rule cannot reach: @Rajeev_ips is on 2 posts, but only one names him ("DGP राजीव शर्मा", in
   * mixed script); the other is the Chief Secretary's post he is tagged on. A spelling on one post is not added (§3).
   */
  const CANNOT: Record<string, string> = { "@Rajeev_ips": "named on 1 of its 2 posts" };
  it("Hindi names test: each person handle with at least 2 posts in the 8 days fires on at least one of them", () => {
    const silent: string[] = [];
    for (const e of entries) {
      const own = posts.filter((p) => p.handles.has(e.handle.replace(/^@/, "").toLowerCase()));
      if (own.length >= 2 && !own.some((p) => fires(e, p.text)) && !CANNOT[e.handle]) silent.push(`${e.handle} (${own.length} posts)`);
    }
    expect(silent).toEqual([]);
    // ...and the exception is still one: a later file change that makes it fire should drop it from CANNOT
    for (const h of Object.keys(CANNOT)) {
      const e = entries.find((x) => x.handle === h)!;
      expect(posts.filter((p) => p.handles.has(h.slice(1).toLowerCase())).some((p) => fires(e, p.text)), h).toBe(false);
    }
  });
  it("the files already carry every spelling the posts give (the script adds nothing more)", () => {
    const r = nameSpellings(entries, posts);
    expect(Object.entries(r.handles).filter(([, v]) => v.added.length).map(([h, v]) => `${h}: ${v.added.join(", ")}`)).toEqual([]);
  });
});

describe("Hindi names: the spelling rules", () => {
  const person = (handle: string, names: string[]): PersonEntry => ({ file: "subject", handle, hiKey: "names_hi", enKey: "names_en", names });
  const post = (text: string, ...handles: string[]) => ({ text, handles: new Set(handles.map((h) => h.toLowerCase())) });

  it("adds a spelling on 2+ of the handle's posts, joined and spaced; not one on a single post; not a run with an extra word", () => {
    const r = nameSpellings(
      [person("@BMA", ["बालमुकुंद आचार्य"])],
      [
        post("विधायक बालमुकुंदाचार्य ने किया दौरा @BMA", "BMA"),
        post("बालमुकुंदाचार्य आज जयपुर में @BMA", "BMA"),
        post("बाल मुकुंद आचार्य का बयान @BMA", "BMA"),
        post("बालमुकुन्द आचार्य पहुंचे @BMA", "BMA"),
      ],
    );
    expect(r.handles["@BMA"]!.added).toEqual(["बालमुकुंदाचार्य", "बाल मुकुंद आचार्य"]);
  });

  it("a spelling that matches more than one person is added to neither, and listed", () => {
    // "राकेश मीणा" on two of @A's posts spells @A's "राजेश मीणा" (one letter off) and is @B's own name
    const r = nameSpellings(
      [person("@A", ["राजेश मीणा"]), person("@B", ["राकेश मीणा"])],
      [post("राकेश मीणा ने कहा @A", "A"), post("राकेश मीणा का दौरा @A", "A")],
    );
    expect(r.handles["@A"]!.added).toEqual([]);
    expect(r.contested).toEqual([{ spelling: "राकेश मीणा", handles: ["a", "b"] }]);
  });

  it("the known @BMacharyaBJP spellings are in party-handles.json", () => {
    const bma = personEntries().find((e) => e.handle === "@BMacharyaBJP")!;
    for (const s of ["बालमुकुंदाचार्य", "बालमुकुन्दाचार्य", "Balmukundachary", "Balmukundacharya"]) expect(bma.names, s).toContain(s);
  });

  it("matching normalises NFC on the text and the lists: a decomposed spelling still fires", () => {
    // "राठौड़" with the nukta decomposed (ड + ़) in the list, precomposed (ड़) in the text, and the other way round
    const nfd = "मदन राठौड़".normalize("NFD");
    expect(fires(person("@X", [nfd]), "मदन राठौड़ ने कहा".normalize("NFC"))).toBe(true);
    expect(fires(person("@X", ["मदन राठौड़".normalize("NFC")]), `${nfd} ने कहा`)).toBe(true);
    const subjects = parseSubjectHandles({ version: 2, entries: [{ handle: "@X1", handle_type: "person", kind: "person", title: "X", names_hi: [nfd], names_en: [], keywords_hi: [], keywords_en: [], verified: true }] });
    expect(subjects.gazetteer.find("मदन राठौड़ का दौरा".normalize("NFC")).map((m) => m.entry.data.handle)).toEqual(["X1"]);
    const parties = parsePartyHandles({ version: 1, entries: [{ handle: "@MLA1", handle_type: "person", name: "MLA", party: "bjp", scope: "mla", keywords_hi: [nfd], keywords_en: [], verified: true }] });
    expect(parties.mla?.length).toBe(1);
  });
});
