// Heading replay (SOCIA_HEADING_GAPS_AND_PLAN 2026-11-23, step 6; gates of 25 Nov 2026): every breaking story the desk
// posted through Socia, re-parsed and re-composed from its FTP file with the CURRENT code and data files, scored against
// the text the desk actually posted. Read only: the input is a JSON export, nothing touches a database.
//
//   node --env-file=.env --import tsx packages/db/scripts/export-golden.ts golden.json     (read-only export)
//   node --import tsx packages/db/scripts/heading-replay.ts golden.json out.json              (exit 1 when a gate fails)
//
// Gates (the run FAILS):
//   - a Rajasthan post with no city that is not flagged no_city;
//   - line 1 naming its city twice (town or district, any spelling);
//   - #Jaipur on a national story (a #FirstIndiaNews post, or a story whose text names only places outside Rajasthan and
//     whose #Jaipur the desk did not write as its dateline, prefix or tag);
//   - the card heading differing from line 1 (P6/P10): checked on EVERY story, the desk's own tag runs, the kept place
//     words ("कोटा ग्रामीण…") and compounds ("जयपुर-जमवारामगढ़…") included, against this file's own reading of line 1 (a lead
//     run's last place, then the text, "#" off; a town tag in place of its word keeps the town; no run, no place in front).
// A missing input field or a renamed core function is an error, never a skip.
// Reported: line-1 place equal to the desk's, wrong city (a city the desk did not use where it used one), flagged stories.

import { readFileSync, writeFileSync } from "node:fs";
import * as core from "@socia/core";
import {
  LEADER_POST, PlaceBook, RAJASTHAN_DISTRICTS, composeBreaking, deskPlaceTag, isRajasthanStory, namesOnlyOutsidePlace, openingPlaceLength, parseBreaking,
  parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, pickReporter, placeSpellings, placeWordInCompound,
  slotFromTags, type BreakingDraft,
} from "@socia/core";

const [input, out] = process.argv.slice(2);
if (!input || !out) {
  console.error("usage: heading-replay.ts <golden.json> <out.json>");
  process.exit(2);
}
const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
/** R6: any problem a data file parser reports stops the run (an entry dropped quietly would change what is replayed) */
const strict = (file: string) => (message: string) => {
  throw new Error(`heading-replay: ${file}: ${message}`);
};
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json"), strict("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"), strict("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"), strict("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"), strict("party-handles.json"));
/** A core function by name: a renamed or missing one stops the run (B7), it never silently turns a data file off */
function call<T>(fn: string, ...args: unknown[]): T {
  const f = (core as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`heading-replay: @socia/core has no function ${fn}: the replay would run without it`);
  return (f as (...a: unknown[]) => T)(...args);
}
const normaliser = call<unknown>("parseHashtagNormalise", cfg("hashtag-normalise.json"), strict("hashtag-normalise.json"), book.districts.map((d) => d.tag));
const suggestRules = call<unknown>("parseSuggestRules", cfg("campaigns.json"), strict("campaigns.json"));
const tagPlaces = call<Parameters<typeof core.tagPlace>[1]>("parseDistricts", cfg("districts.json"), strict("districts.json"));

interface Row { file_name: string; source_text: string; created_at: string; posted: string }
const rows = JSON.parse(readFileSync(input, "utf8")) as Row[];
if (!Array.isArray(rows) || !rows.length) throw new Error("heading-replay: the input holds no rows");
rows.forEach((r, i) => {
  for (const k of ["file_name", "source_text", "created_at", "posted"] as const) {
    if (typeof r[k] !== "string" || !r[k]) throw new Error(`heading-replay: row ${i} has no ${k}`);
  }
});

/** A hashtag; an English tag joined by hyphens is one ("#Kotputli-Behror", P5) */
const TAG_SRC = String.raw`#([\p{L}\p{M}\p{N}_]+(?:-[A-Za-z0-9]+)*)`;
const TAG = new RegExp(TAG_SRC, "gu");
const tagsOf = (s: string) => [...s.matchAll(TAG)].map((m) => m[1]!);
const DEVANAGARI = /[ऀ-ॿ]/u;
/** rajasthan.ts's other Latin names of a district ("Khairthal", "Didwana", "Kotputli"), folded to the district's name */
const DISTRICT_ALIAS = new Map(RAJASTHAN_DISTRICTS.flatMap((d) => d.aliases.filter((a) => /^[A-Za-z]/.test(a)).map((a) => [a.toLowerCase().replace(/[\s_-]+/g, ""), d.name] as const)));
/** The place a tag names, as one key: the district or national place's name, or "town:<hi>"; alias-aware (the desk's #Khairthal is Khairthal-Tijara) */
function placeKey(tag: string): string | null {
  const p = core.placeOfTag(book, tag);
  if (p) return p.kind === "town" ? `town:${p.hi}` : `d:${p.districts[0]?.name ?? p.hi}`;
  const alias = DISTRICT_ALIAS.get(tag.toLowerCase().replace(/[\s_-]+/g, "").replace(/news$/, ""));
  if (alias) return `d:${alias}`;
  const t = core.tagPlace(tag, tagPlaces);
  return t ? `x:${t.place.toLowerCase()}` : null;
}
const cityKeys = (text: string) => new Set(tagsOf(text).map(placeKey).filter((k): k is string => !!k));
/**
 * A post carries a city hashtag the way the composer reads one (Q2): a place tag (any spelling, a district's other name),
 * or an unknown single Hindi word leading line 1's run before the colon that is not a party, topic or label word
 */
function hasCityTag(post: string): boolean {
  if (cityKeys(post).size > 0) return true;
  const line1 = post.split("\n")[0]!.trim();
  const run = new RegExp(String.raw`^((?:${TAG_SRC}\s*)+)[:：]`, "u").exec(line1)?.[1] ?? "";
  const lead = new Set(tagsOf(run));
  return tagsOf(post).some((t) => deskPlaceTag(book, t, lead.has(t)));
}

/** Every spelling of the place a tag names, as the composer reads them (compose.ts placeSpellings) */
function spellings(tag: string): string[] {
  const p = core.placeOfTag(book, tag);
  if (!p) return [tag];
  return p.kind === "town" ? [tag, p.hi] : [tag, ...placeSpellings(book, p.districts[0]!)];
}
/** The opening, unless the place word is part of a compound or route ("बेगूं-चित्तौड़गढ़ मार्ग"): R3, not a second naming */
const opensWith = (rest: string, names: string[]) => {
  const k = openingPlaceLength(rest, names);
  return k > 0 && !placeWordInCompound(rest, k);
};
const LEAD_RUN = new RegExp(String.raw`^((?:${TAG_SRC}\s*)+)[:：]\s*(.*)$`, "u");
/** "town" | "district" when line 1 names a lead place again as the headline's opening, in any spelling (B4) */
function twice(line1: string): "town" | "district" | null {
  const m = LEAD_RUN.exec(line1.trim());
  if (!m) return null;
  const lead = tagsOf(m[1]!);
  const rest = m.at(-1)!;
  const last = lead.at(-1)!;
  const lastPlace = core.placeOfTag(book, last);
  if (lastPlace?.kind === "town" && opensWith(rest, spellings(last))) return "town";
  if (!lastPlace && DEVANAGARI.test(last) && opensWith(rest, [last])) return "town";
  for (const t of lead) {
    const p = core.placeOfTag(book, t);
    if (p && p.kind !== "town" && opensWith(rest, spellings(t))) return "district";
  }
  return null;
}
const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const leadKeys = (line1: string) => {
  const m = new RegExp(String.raw`^((?:${TAG_SRC}\s*)+)`, "u").exec(line1.trim());
  return new Set((m ? tagsOf(m[1]!) : []).map(placeKey).filter((k): k is string => !!k));
};

/**
 * P6/P10: the card heading for a line 1, read here independently of the composer (as the desk's X cards of 23–24 Nov show
 * it): a lead run ending in ":" with a place puts its LAST place in front (a town or Hindi tag as written, a Latin district or
 * national place by name, a desk tag as written), then the text with every "#" off; a run of place tags standing in for a
 * word ("#Bundi #नैनवां में…") keeps its last tag; otherwise line 1 with "#" off and no place in front.
 */
function expectedCard(line1: string): string {
  const line = line1.normalize("NFC").replace(/\s+/g, " ").trim();
  const off = (t: string) => t.replace(/#(?=[\p{L}\p{M}\p{N}_])/gu, "").replace(/\s+/g, " ").trim();
  const isPlace = (t: string) => core.placeOfTag(book, t) !== null || deskPlaceTag(book, t, true);
  const name = (t: string) => {
    const p = core.placeOfTag(book, t);
    const d = p && p.kind !== "town" ? p.districts[0] : null;
    if (!d || DEVANAGARI.test(t)) return t;
    if (d.deskTag && d.deskTag.toLowerCase() === t.toLowerCase()) return d.deskTag;
    return d.rajasthan ? d.name : d.name.replace(/([a-z])([A-Z])/g, "$1 $2");
  };
  const run = new RegExp(String.raw`^((?:${TAG_SRC}\s*)+)[:：]\s*`, "u").exec(line);
  if (run) {
    const last = tagsOf(run[1]!).filter(isPlace).at(-1);
    if (last) {
      const rest = off(line.slice(run[0].length));
      return rest ? `${name(last)}: ${rest}` : name(last);
    }
  }
  const inline = new RegExp(String.raw`^((?:${TAG_SRC}\s+)+)(?=[^#\s])`, "u").exec(line);
  if (inline) {
    const tags = tagsOf(inline[1]!);
    if (tags.length > 1 && tags.every(isPlace)) return `${tags.at(-1)} ${off(line.slice(inline[0].length))}`.trim();
  }
  return off(line);
}
/** A place in front of the card ("Kota: …") only when line 1 has a lead run with a place (never the old D1 "Kota:" on its own) */
const cardPrefixWithoutRun = (line1: string, card: string) => !LEAD_RUN.test(line1.trim()) && /^[^\s:：]{2,30}[:：]\s/u.test(card) && !/^[^\s:：]{2,30}[:：]\s/u.test(line1.replace(/#/g, "").trim());

const result = rows.map((r) => {
  const p = parseBreaking(r.source_text, r.file_name, book);
  const slot = slotFromTags(p.tags);
  const text = [p.headline, p.points.join("\n")].join(" । ");
  // R6: as the worker decides it (apps/worker/src/stages/compose.ts, core isRajasthanStory): a stated place, else the text and
  // the file's national rules with the reporter's districts
  const worksAsRajasthan = isRajasthanStory(book, p.district, p.tags, text, pickReporter(slot.reporterToken, reporters).match?.districts);
  const d: BreakingDraft = composeBreaking(
    {
      headline: p.headline, points: p.points, district: p.district, districtFrom: p.districtFrom, town: p.town, rajasthan: worksAsRajasthan,
      leaderPost: LEADER_POST.test(p.headline), rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district,
      unknownBureauCode: slot.unknownCode,
    },
    rules, book, { subjects, reporters, parties, normaliser, suggestRules, at: new Date(r.created_at) } as Parameters<typeof composeBreaking>[3],
  );
  const ours = [d.bodyText, d.hashtags.join(" ")].join("\n\n");
  const desk = r.posted;
  const ourLine1 = d.bodyText.split("\n")[0] ?? "";
  const deskLine1 = desk.split("\n")[0] ?? "";
  const rajasthan = d.hashtags[0] === "#RajasthanWithFirstIndia";
  const hp = d.headingPlace;
  const ourCity = [...cityKeys(ours)];
  const deskCity = [...cityKeys(desk)];
  const card = hp.cardHeadline ?? null;
  const expected = expectedCard(ourLine1);
  const jaipur = ourCity.includes("d:Jaipur");
  return {
    file: r.file_name, at: r.created_at, district: p.district, districtFrom: p.districtFrom, town: p.town, rajasthan,
    ourLine1, deskLine1, ourTags: d.hashtags, suggest: d.hashtagSuggestions, headingPlace: hp, storyHeadline: p.headline, noCity: d.noCity, cityFlag: d.cityFlag,
    cityTagOurs: hasCityTag(ours), cityTagDesk: hasCityTag(desk),
    deskPlaceNoTag: !hasCityTag(ours) && hp.placement === "copy",
    twiceOurs: twice(ourLine1), twiceDesk: twice(deskLine1),
    leadEqual: eq(leadKeys(ourLine1), leadKeys(deskLine1)),
    cityEqual: eq(new Set(ourCity), new Set(deskCity)),
    wrongCity: deskCity.length > 0 && ourCity.some((k) => !deskCity.includes(k)),
    // A national post, or a story whose text names only outside places where #Jaipur did not come from the desk's own words
    // (a "जयपुर" dateline, a "जयपुर:" prefix or tag is the desk stating the place)
    jaipurOnNational: jaipur && (!rajasthan || (namesOnlyOutsidePlace(book, text) && !core.isExplicitDistrict(p.districtFrom))),
    card, expectedCard: expected,
    // P6/P10: on EVERY story (the old gate skipped the D1-guard and compound cases: that is how "Kota: ग्रामीण…" passed)
    cardEqual: card !== null && card === expected,
    cardPrefixWithoutRun: card !== null && cardPrefixWithoutRun(ourLine1, card),
    ourCity, deskCity,
  };
});
writeFileSync(out, JSON.stringify(result, null, 1));

const n = result.length;
const pct = (k: number, of = n) => `${k}/${of} (${((100 * k) / Math.max(1, of)).toFixed(1)}%)`;
const by = (f: (x: (typeof result)[number]) => boolean, xs = result) => xs.filter(f).length;
const raj = result.filter((x) => x.rajasthan);
const nat = result.filter((x) => !x.rajasthan);
const missing = (x: (typeof result)[number]) => x.rajasthan && !x.cityTagOurs && !x.deskPlaceNoTag && !x.noCity;
console.log(`stories: ${n} (Rajasthan ${raj.length}, national ${nat.length})`);
console.log(`city missing on Rajasthan, not flagged  ${by(missing)}   (desk wrote a place without a hashtag: ${by((x) => x.deskPlaceNoTag)})`);
console.log(`flagged                          Rajasthan no_city ${by((x) => x.cityFlag === "no_city", raj)} of ${raj.length}, national_story ${by((x) => x.cityFlag === "national_story", nat)} of ${nat.length}`);
console.log(`#Jaipur on a national story      ${by((x) => x.jaipurOnNational)}`);
console.log(`wrong city (desk used another)   ${by((x) => x.wrongCity)}`);
console.log(`town said twice                  ours ${by((x) => x.twiceOurs === "town")}   desk ${by((x) => x.twiceDesk === "town")}`);
console.log(`district said twice              ours ${by((x) => x.twiceOurs === "district")}   desk ${by((x) => x.twiceDesk === "district")}`);
console.log(`line-1 place = desk              ${pct(by((x) => x.leadEqual))}`);
console.log(`post city tags = desk            ${pct(by((x) => x.cityEqual))}`);
console.log(`card = caption line 1            ${pct(by((x) => x.cardEqual))}   (a place in front with no lead run: ${by((x) => x.cardPrefixWithoutRun)})`);
const gates: [string, number][] = [
  ["Rajasthan posts with no city that are not flagged no_city", by(missing)],
  ["line 1 naming its town twice", by((x) => x.twiceOurs === "town")],
  ["line 1 naming its district twice", by((x) => x.twiceOurs === "district")],
  ["#Jaipur on a national story", by((x) => x.jaipurOnNational)],
  ["card heading differing from line 1", by((x) => !x.cardEqual)],
  ["a place in front of the card with no lead run on line 1", by((x) => x.cardPrefixWithoutRun)],
];
const failed = gates.filter(([, k]) => k > 0);
for (const [what, k] of failed) console.log(`GATE FAILED: ${what}: ${k}`);
process.exitCode = failed.length ? 1 : 0;
