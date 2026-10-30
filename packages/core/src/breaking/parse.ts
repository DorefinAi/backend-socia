// The newsroom's breaking .txt files: line 1 repeats the file name; then an optional place line
// ("जयपुर", "जोधपुर से खबर", "दौसा के बांदीकुई से खबर", "करौली से <reporter> की रिपोर्ट"); then the
// headline; then one point per line. Desk instructions ("नोट-: ... फुलस्क्रीन करावें") are taken out and
// flagged. Rules only: anything odd is flagged for a human, never guessed by a model.

import { fileTags, type FileTags } from "./filename";
import type { DistrictInfo, Place, PlaceBook } from "./places";

export const NEEDS_CHECK = [
  "empty", "no_headline", "no_hindi", "very_long", "no_district", "desk_note", "headline_cut",
  /** The same file was saved again with new text; its unposted draft was rewritten */
  "resaved",
  /** The file was saved again after its post went out: a new draft, linked to the posted one */
  "update_of_posted",
] as const;
/** Set by the ingest stage, not the parser: they survive a re-parse */
export const STICKY_CHECKS: readonly NeedsCheck[] = ["resaved", "update_of_posted"];
export type NeedsCheck = (typeof NEEDS_CHECK)[number];
/** These make the queue's "needs review" flag; the others are worth a look but usually fine */
export const SERIOUS_CHECKS: readonly NeedsCheck[] = ["empty", "no_headline", "no_hindi", "very_long"];

/** More lines than this is not a breaking item (the 109-line file) */
export const MAX_BREAKING_LINES = 25;

export type DistrictFrom = "place_line" | "headline_prefix" | "file_code" | "text";

export interface BreakingStory {
  headline: string;
  points: string[];
  /** English district (Rajasthan) or national place name, as stories.district */
  district: string | null;
  districtFrom: DistrictFrom | null;
  /** Hindi town from the place line, when it is not the district itself */
  town: string | null;
  /** The district is in Rajasthan; false for Delhi, Bihar, Pakistan, ... and for national news without a place */
  rajasthan: boolean;
  /** "<leader> की पोस्ट": the headline is the context line, the points are the post */
  leaderPost: boolean;
  /** The removed desk instructions, one per line; null when none */
  deskNote: string | null;
  tags: FileTags;
  needsCheck: NeedsCheck[];
}

const DEVANAGARI = /[ऀ-ॿ]/;
/** Leftovers from Word/Notepad: zero-width spaces, word joiners, BOM. ZWJ/ZWNJ stay: they shape Devanagari conjuncts */
const INVISIBLE = /[\u200B\u2060\uFEFF]/g;

/** "नोट-:", "नोट :-", "NOTE :", and any "फुलस्क्रीन करावें" instruction. "नोट और दारू" (bank notes) is news. */
const DESK_NOTE = /^(?:नोट|note)\s*[-:–—]+|फुल\s*स्क्रीन\s*(?:करावें|कराएं|करें|कराये|चलावें|चलाएं)|full\s*screen\s+(?:only|karayen)/iu;
/** A line that does not finish its sentence: the next line continues it */
const CONTINUES = /(?:,|，|\s(?:और|एवं|तथा|व))$/u;
const BULLET = /^(?:[-–—•●▪■◆➤►>*]+|\d{1,2}[.)])\s*/u;
/** "<leader> की पोस्ट" / "... ने दी शुभकामनाएं": the headline is a leader's own post */
export const LEADER_POST = /(?:की|का)\s+(?:पोस्ट|ट्वीट|ट्विट|बयान)$|ने\s+(?:दी|दीं)\s+(?:शुभकामनाएं|शुभकामनाएँ|बधाई|श्रद्धांजलि)$|ने\s+कहा$/u;

/** State-level news: the capital's desk, no district to tag */
const STATEWIDE = /राजस्थान|प्रदेश|राज्य|सचिवालय|मुख्यमंत्री|सीएम|मुख्य\s*सचिव|(?<![A-Za-z])(?:IAS|ACS|RAS)(?![A-Za-z])|विधानसभा|मंत्रिमंडल|कैबिनेट/u;

/** "<place> से (बड़ी) खबर" / "<place> में खबर" */
const PLACE_NEWS = /^(.+?)\s+(?:से|में)\s+(?:बड़ी\s+|ताजा\s+|ताज़ा\s+|अहम\s+|खास\s+)?ख़?ख?बर$/u;
/** "<place> से <reporter> की (एक्सक्लूसिव) रिपोर्ट/खबर" */
const PLACE_BYLINE = /^(.+?)\s+से\s+.+?\s+की\s+(?:एक्सक्लूसिव\s+|खास\s+|विशेष\s+)?(?:रिपोर्ट|खबर)$/u;
/** "<reporter> की (एक्सक्लूसिव) रिपोर्ट": a byline with no place */
const BYLINE = /^.{2,60}\s+की\s+(?:एक्सक्लूसिव\s+|खास\s+|विशेष\s+)?रिपोर्ट$/u;
/** "रेनवाल (जयपुर)", "अंता(बारां)" */
const TOWN_IN_BRACKETS = /^(.+?)\s*\((.+?)\)$/u;
/** Words that a one-word line can be without being a place */
const NOT_A_PLACE = /बड़ा|बड़ी|बड़े|खबर|हादसा|कार्रवाई|खुलासा|मामला|सनसनी|अपडेट|ब्रेकिंग|एक्सक्लूसिव|विज्ञापन|सूचना|अलर्ट|लाइव|दौरा|बयान|चुनाव|बैठक|हत्या|मौत|आग|फैसला|नियुक्ति|तबादला|पोस्ट/u;

interface Located {
  district: DistrictInfo | null;
  town: string | null;
}

const clean = (line: string) => line.replace(INVISIBLE, "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => s.split(" ").filter(Boolean).length;

/** The district that `place` belongs to; for an ambiguous town, the one the file code names, if any */
function districtOf(place: Place, hint: string | null): DistrictInfo {
  return place.districts.find((d) => d.name === hint) ?? place.districts[0]!;
}

/** A place phrase: "रावतभाटा", "दौसा के बांदीकुई", "चित्तौड़गढ़ से निम्बाहेड़ा" (typo), "रेनवाल (जयपुर)", "खैरथल जिले के मुण्डावर" */
function resolvePlace(book: PlaceBook, phrase: string, hint: string | null, allowUnknownTown: boolean): Located | null {
  const p = phrase.replace(/\s+जिले?$/u, "").trim();
  if (!p) return null;
  const whole = book.lookup(p);
  if (whole) return located(whole, null, hint);

  const pair = /^(.+?)\s+(?:जिले\s+)?(?:के|से|का|की)\s+(.+)$/u.exec(p) ?? swap(TOWN_IN_BRACKETS.exec(p));
  if (pair) {
    const outer = book.lookup(pair[1]!.replace(/\s+जिले?$/u, ""));
    const inner = book.lookup(pair[2]!);
    if (outer && outer.kind !== "town") {
      const town = inner?.hi ?? (words(pair[2]!) <= 3 && DEVANAGARI.test(pair[2]!) ? pair[2]! : null);
      return { district: outer.districts[0]!, town: town && town !== outer.hi ? town : null };
    }
    if (inner) return located(inner, null, outer ? districtOf(outer, hint).name : hint);
    if (outer) return located(outer, null, hint);
  }
  if (allowUnknownTown && words(p) <= 2 && DEVANAGARI.test(p) && !/[0-9:]/.test(p) && !NOT_A_PLACE.test(p)) return { district: null, town: p };
  return null;
}

/** "रेनवाल (जयपुर)" reads town then district; turn it into [_, district, town] */
function swap(m: RegExpExecArray | null): [string, string, string] | null {
  return m ? [m[0], m[2]!, m[1]!] : null;
}

function located(place: Place, town: string | null, hint: string | null): Located {
  const district = districtOf(place, hint);
  if (place.kind === "town") return { district, town: place.hi };
  return { district, town };
}

/** The place line, when line 0 is one; null when it is already the headline. */
function placeLine(book: PlaceBook, line: string, hint: string | null): Located | "byline" | null {
  if (words(line) > 9 || /[:।?!]/.test(line)) return null;
  const byline = PLACE_BYLINE.exec(line);
  if (byline) return resolvePlace(book, byline[1]!, hint, true) ?? "byline";
  if (BYLINE.test(line) && words(line) <= 7) return "byline";
  const news = PLACE_NEWS.exec(line);
  // "परिवहन विभाग से बड़ी खबर" is a headline in the house style; only a place (or one unknown word) is a place line
  if (news) return resolvePlace(book, news[1]!, hint, words(news[1]!) === 1);
  if (words(line) <= 4) return resolvePlace(book, line, hint, words(line) <= 2);
  return null;
}

/** "मेड़तासिटी : पंच व सरपंच के चुनाव कल" → the place, and the headline without it */
function headlinePrefix(book: PlaceBook, headline: string, hint: string | null): { place: Located; rest: string } | null {
  const m = /^([^:：]{2,30}?)\s*[:：]\s*[-–]?\s*(.+)$/u.exec(headline);
  if (!m || words(m[1]!) > 3) return null;
  const place = resolvePlace(book, m[1]!, hint, words(m[1]!) <= 2 && DEVANAGARI.test(m[1]!));
  return place ? { place, rest: m[2]! } : null;
}

/** First place named in the text: Rajasthan wins over a national place in the same text */
function placeInText(book: PlaceBook, text: string, hint: string | null): { district: DistrictInfo; national: boolean } | null {
  const found = book.find(text);
  const raj = found.find((m) => m.entry.data.kind !== "national");
  if (raj) return { district: districtOf(raj.entry.data, hint), national: false };
  const nat = found[0];
  return nat ? { district: nat.entry.data.districts[0]!, national: true } : null;
}

export function parseBreaking(text: string, fileName: string, book: PlaceBook): BreakingStory {
  const tags = fileTags(fileName, book.codes);
  const hint = tags.district;
  const needsCheck: NeedsCheck[] = [];
  const flag = (c: NeedsCheck) => {
    if (!needsCheck.includes(c)) needsCheck.push(c);
  };

  let lines = text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map(clean).filter(Boolean);
  // Line 1 repeats the file name (Latin, underscores); a name typed with a stray Hindi letter still counts
  if (lines[0] && !DEVANAGARI.test(lines[0].replace(/^[ऀ-ॿ]\s*/u, "")) && /_/.test(lines[0]) && /btn|breaking|nat_|_rj_|_raj_/i.test(lines[0])) {
    lines = lines.slice(1);
  }
  // Separator rows (----, ****) and stray keystrokes ("ब्") carry nothing
  lines = lines.filter((l) => /\p{L}.*\p{L}|\p{N}/u.test(l));

  const notes = lines.filter((l) => DESK_NOTE.test(l));
  lines = lines.filter((l) => !DESK_NOTE.test(l));
  if (notes.length) flag("desk_note");

  // A line ending in a comma or "और / एवं / तथा / व" goes on with the next one
  const joined: string[] = [];
  for (const l of lines) {
    const prev = joined.at(-1);
    if (prev !== undefined && CONTINUES.test(prev)) joined[joined.length - 1] = `${prev} ${l}`;
    else joined.push(l);
  }
  lines = joined;

  if (!lines.length) {
    flag("empty");
    return { headline: "", points: [], district: hint, districtFrom: hint ? "file_code" : null, town: null, rajasthan: hint !== "Delhi", leaderPost: false, deskNote: notes.join("\n") || null, tags, needsCheck };
  }
  if (lines.length > MAX_BREAKING_LINES) flag("very_long");

  let where = null as Located | null;
  let from = null as DistrictFrom | null;
  // Up to three place / byline lines before the headline ("करौली से <reporter> की रिपोर्ट", then "मासलपुर")
  for (let n = 0; n < 3 && lines.length > 1; n++) {
    const p = placeLine(book, lines[0]!, hint);
    if (!p) break;
    lines = lines.slice(1);
    if (p === "byline") continue;
    if (!where?.district && p.district) from = "place_line";
    where = { district: where?.district ?? p.district, town: where?.town ?? p.town };
  }

  let headline = lines[0]!.replace(BULLET, "");
  const prefix = headlinePrefix(book, headline, hint);
  if (prefix) {
    headline = prefix.rest;
    if (!where?.district) {
      where = { district: prefix.place.district ?? where?.district ?? null, town: where?.town ?? prefix.place.town };
      from = "headline_prefix";
    } else if (!where.town && prefix.place.town && prefix.place.district?.name === where.district.name) {
      where.town = prefix.place.town;
    }
  }
  const points = lines.slice(1).map((l) => l.replace(BULLET, "")).filter(Boolean);

  let district = where?.district ?? null;
  let national = district ? !district.rajasthan : false;
  if (!district && hint) {
    district = book.district(hint);
    from = "file_code";
    national = !!district && !district.rajasthan;
  }
  // A town on its own (no district yet): the town's district, if the gazetteer knows the town
  if (!district && where?.town) {
    const t = book.lookup(where.town);
    if (t) {
      district = districtOf(t, hint);
      from = "place_line";
    }
  }
  if (!district) {
    const inText = placeInText(book, headline, hint) ?? placeInText(book, points.slice(0, 2).join(" । "), hint);
    if (inText && !inText.national) {
      district = inText.district;
      from = "text";
    } else if (inText) {
      national = true;
    }
  }
  // National news with no place (NWS desk files) is not missing a district
  if (!district && !national && tags.other.includes("NWS")) national = true;
  const leaderPost = LEADER_POST.test(headline);
  // A leader's post and state-wide news (secretariat, a state decision) have no district and need none
  if (!district && !national && !leaderPost && !STATEWIDE.test([headline, ...points].join(" "))) flag("no_district");

  if (!headline) flag("no_headline");
  if (!DEVANAGARI.test([headline, ...points].join(" "))) flag("no_hindi");

  // A town tag without its district reads oddly ("#सचिवालय:"): keep it only with a district
  const town = district && where?.town && where.town !== district.hi ? where.town : null;
  return {
    headline,
    points,
    district: district?.name ?? null,
    districtFrom: district ? from : null,
    town,
    rajasthan: district ? district.rajasthan : !national,
    leaderPost,
    deskNote: notes.length ? notes.join("\n") : null,
    tags,
    needsCheck,
  };
}
