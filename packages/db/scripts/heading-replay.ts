// Heading replay (SOCIA_HEADING_GAPS_AND_PLAN 2026-11-23, step 6): every breaking story the desk posted through
// Socia, re-parsed and re-composed from its FTP file with the CURRENT code and data files, scored against the text
// the desk actually posted. Read only: the input is a JSON export, nothing touches a database.
//
//   node --env-file=.env --import tsx packages/db/scripts/export-golden.ts golden.json     (read-only export)
//   node --import tsx packages/db/scripts/heading-replay.ts golden.json out.json              (exit 1 when a gate fails)
//
// Gates (the run FAILS): a Rajasthan post with no city; line 1 naming its city twice (town or district, any spelling);
// the card's place differing from line 1's. A missing input field or a renamed core function is an error, never a skip.
// Reported: line-1 place equal to the desk's, wrong city (a city the desk did not use where it used one), national posts
// flagged no_city, desk places written without a hashtag.

import { readFileSync, writeFileSync } from "node:fs";
import * as core from "@socia/core";
import {
  LEADER_POST, PlaceBook, composeBreaking, deskPlaceTag, nationalWithoutPlace, openingPlaceLength, parseBreaking, parseHandleRules, parsePartyHandles,
  parsePlacesData, parseReporterHandles, parseSubjectHandles, pickReporter, placeMatchKey, placeSpellings, placeWordInCompound, slotFromTags, type BreakingDraft,
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
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
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

const TAG = /#([\p{L}\p{M}\p{N}_]+)/gu;
const tagsOf = (s: string) => [...s.matchAll(TAG)].map((m) => m[1]!);
const DEVANAGARI = /[ऀ-ॿ]/u;
/** The place a tag names, as one key: the district or national place's name, or "town:<hi>" */
function placeKey(tag: string): string | null {
  const p = core.placeOfTag(book, tag);
  if (p) return p.kind === "town" ? `town:${p.hi}` : `d:${p.districts[0]?.name ?? p.hi}`;
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
  const run = /^((?:#[\p{L}\p{M}\p{N}_]+\s*)+)[:：]/u.exec(line1)?.[1] ?? "";
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
/** "town" | "district" when line 1 names a lead place again as the headline's opening, in any spelling (B4) */
function twice(line1: string): "town" | "district" | null {
  const m = /^((?:#[\p{L}\p{M}\p{N}_]+\s*)+)[:：]\s*(.*)$/u.exec(line1.trim());
  if (!m) return null;
  const lead = tagsOf(m[1]!);
  const rest = m[2]!;
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
/**
 * Line 1's place as the post shows it (B7: read from the composed text, not from headingPlace): the lead run's last place,
 * the town tag standing in for a word, or the tag line's city (its town if one, else its district). Null when none.
 */
function postPlace(d: BreakingDraft): string | null {
  const line1 = d.bodyText.split("\n")[0] ?? "";
  const run = /^((?:#[\p{L}\p{M}\p{N}_]+\s*)+)/u.exec(line1.trim())?.[1];
  const pick = (tags: string[]) => {
    // A town is a Hindi tag, known to the places file or not ("#तखतगढ़", "#सियोल"); else the first district or national place
    const town = tags.find((t) => DEVANAGARI.test(t) || core.placeOfTag(book, t)?.kind === "town");
    if (town) return town;
    const first = tags.map((t) => core.placeOfTag(book, t)).find((p) => p);
    return first ? (first.districts[0]?.name ?? null) : null;
  };
  if (run && d.headingPlace.placement !== "trailing") return pick(tagsOf(run));
  return pick(d.hashtags.slice(1).map((t) => t.replace(/^#/, "")));
}
const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const leadKeys = (line1: string) => {
  const m = /^((?:#[\p{L}\p{M}\p{N}_]+\s*)+)/u.exec(line1.trim());
  return new Set((m ? tagsOf(m[1]!) : []).map(placeKey).filter((k): k is string => !!k));
};

const result = rows.map((r) => {
  const p = parseBreaking(r.source_text, r.file_name, book);
  const slot = slotFromTags(p.tags);
  // R6: as the worker decides it (apps/worker/src/stages/compose.ts): a stated place, else the national-desk rule with the
  // reporter's districts
  const place = book.district(p.district);
  const worksAsRajasthan = place ? place.rajasthan : !nationalWithoutPlace(p.tags, [p.headline, p.points.join("\n")].join(" । "), book, pickReporter(slot.reporterToken, reporters).match?.districts);
  const d = composeBreaking(
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
  const linePlace = hp.placement === "copy" || hp.placement === "none" ? null : postPlace(d);
  const ourCity = [...cityKeys(ours)];
  const deskCity = [...cityKeys(desk)];
  return {
    file: r.file_name, at: r.created_at, district: p.district, districtFrom: p.districtFrom, town: p.town, rajasthan,
    ourLine1, deskLine1, ourTags: d.hashtags, suggest: d.hashtagSuggestions, headingPlace: hp, storyHeadline: p.headline, noCity: d.noCity,
    cityTagOurs: hasCityTag(ours), cityTagDesk: hasCityTag(desk),
    deskPlaceNoTag: !hasCityTag(ours) && hp.placement === "copy",
    twiceOurs: twice(ourLine1), twiceDesk: twice(deskLine1),
    leadEqual: eq(leadKeys(ourLine1), leadKeys(deskLine1)),
    cityEqual: eq(new Set(ourCity), new Set(deskCity)),
    wrongCity: deskCity.length > 0 && ourCity.some((k) => !deskCity.includes(k)),
    cardChecked: !!linePlace || !!hp.card,
    cardEqual: !linePlace && !hp.card ? true : !!linePlace && !!hp.card && placeMatchKey(linePlace) === placeMatchKey(hp.card),
    ourCity, deskCity,
  };
});
writeFileSync(out, JSON.stringify(result, null, 1));

const n = result.length;
const pct = (k: number, of = n) => `${k}/${of} (${((100 * k) / Math.max(1, of)).toFixed(1)}%)`;
const by = (f: (x: (typeof result)[number]) => boolean, xs = result) => xs.filter(f).length;
const raj = result.filter((x) => x.rajasthan);
const nat = result.filter((x) => !x.rajasthan);
const checked = result.filter((x) => x.cardChecked);
console.log(`stories: ${n} (Rajasthan ${raj.length}, national ${nat.length})`);
console.log(`city tag missing, not flagged   ${by((x) => !x.cityTagOurs && !x.deskPlaceNoTag && !x.noCity)}   (desk wrote a place without a hashtag: ${by((x) => x.deskPlaceNoTag)})`);
console.log(`flagged no_city                  Rajasthan ${by((x) => x.noCity, raj)} of ${raj.length}, national ${by((x) => x.noCity, nat)} of ${nat.length}`);
console.log(`#Jaipur not from a reporter rule  ${by((x) => x.ourCity.includes("d:Jaipur") && x.headingPlace.source !== "reporter_rule" && x.headingPlace.district !== "Jaipur")}`);
console.log(`wrong city (desk used another)   ${by((x) => x.wrongCity)}`);
console.log(`town said twice                  ours ${by((x) => x.twiceOurs === "town")}   desk ${by((x) => x.twiceDesk === "town")}`);
console.log(`district said twice              ours ${by((x) => x.twiceOurs === "district")}   desk ${by((x) => x.twiceDesk === "district")}`);
console.log(`line-1 place = desk              ${pct(by((x) => x.leadEqual))}`);
console.log(`post city tags = desk            ${pct(by((x) => x.cityEqual))}`);
console.log(`card place = line-1 place        ${pct(by((x) => x.cardEqual, checked), checked.length)}`);
const gates: [string, number][] = [
  ["posts with no city that are not flagged no_city", by((x) => !x.cityTagOurs && !x.deskPlaceNoTag && !x.noCity)],
  ["line 1 naming its town twice", by((x) => x.twiceOurs === "town")],
  ["line 1 naming its district twice", by((x) => x.twiceOurs === "district")],
  ["card place differing from line 1's", by((x) => !x.cardEqual)],
];
const failed = gates.filter(([, k]) => k > 0);
for (const [what, k] of failed) console.log(`GATE FAILED: ${what}: ${k}`);
process.exitCode = failed.length ? 1 : 0;
