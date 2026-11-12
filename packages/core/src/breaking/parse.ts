// The newsroom's breaking .txt files: line 1 repeats the file name; then an optional place line
// ("जयपुर", "जोधपुर से खबर", "दौसा के बांदीकुई से खबर", "करौली से <reporter> की रिपोर्ट"); then the
// headline; then one point per line. Desk instructions ("नोट-: ... फुलस्क्रीन करावें") are taken out and
// flagged. Rules only: anything odd is flagged for a human, never guessed by a model.

import { fold } from "../fold";
import { fileTags, type FileTags } from "./filename";
import type { DistrictInfo, Place, PlaceBook } from "./places";

/**
 * Party and election words in a headline's prefix. A PARSING rule only: "भाजपा: ..." and "#BJP #Kota:"
 * are not place prefixes, so they stay in the headline as the desk wrote them. Which handles party copy
 * gets is storyclass.ts's and parties.ts's job — this regex no longer decides anything about tagging.
 */
export const PARTY = /भाजपा|बीजेपी|कांग्रेस|प्रत्याशी|उम्मीदवार|जनसंपर्क|चुनाव\s*प्रचार|चुनावी|पंचायत\s*चुनाव|पंचायतीराज\s*चुनाव|सरपंच\s*चुनाव|मतदान|नामांकन|रैली|प्रदेशाध्यक्ष|पीसीसी|\bBJP\b|\bCongress\b|\bINC\b/iu;

export const NEEDS_CHECK = [
  "empty", "no_headline", "no_hindi", "very_long", "no_district", "desk_note", "headline_cut",
  /** The same file was saved again with new text; its unposted draft was rewritten */
  "resaved",
  /** The file was saved again after its post went out: a new draft, linked to the posted one */
  "update_of_posted",
  /** The headline's place tags ("#Kota:") name another district than the place line, or two districts; the first tag won */
  "place_conflict",
] as const;
/** Set by the ingest stage, not the parser: they survive a re-parse */
export const STICKY_CHECKS: readonly NeedsCheck[] = ["resaved", "update_of_posted"];
export type NeedsCheck = (typeof NEEDS_CHECK)[number];
/** These make the queue's "needs review" flag; the others are worth a look but usually fine */
export const SERIOUS_CHECKS: readonly NeedsCheck[] = ["empty", "no_headline", "no_hindi", "very_long"];

/** More lines than this is not a breaking item (the 109-line file) */
export const MAX_BREAKING_LINES = 25;

/**
 * Where a story's district came from. The desk NAMED it (explicit) or we worked it out (inferred), and only an
 * explicit district may reach the post: line 1's hashtag, the district police and the collector (b6 fix brief
 * P0). An inferred one is offered to the desk as a suggestion and nothing else.
 *   place_line       the dateline line ("जोधपुर से खबर", "रावतभाटा") — explicit
 *   headline_prefix  the desk's own place prefix ("#Kota:", "मेड़तासिटी :") — explicit
 *   tag              the one Rajasthan district hashtag the desk wrote in the headline ("#BJP #Kota: ...") — explicit
 *   file_code        the file name's bureau code: the FILING desk. Stated (explicit) unless the reporter is a
 *                    bureau filing for no single district (Navin files every district's ACB story as JPR):
 *                    composeBreaking's storyDistrict decides, since only it knows the reporters
 *   text             a place the headline or the first points mention — inferred
 */
export type DistrictFrom = "place_line" | "headline_prefix" | "tag" | "file_code" | "text";
/** Explicit whoever filed it. file_code is explicit too, but only for a reporter tied to one district (storyDistrict). */
export const EXPLICIT_DISTRICT_SOURCES: ReadonlySet<DistrictFrom> = new Set<DistrictFrom>(["place_line", "headline_prefix", "tag"]);
export const isExplicitDistrict = (from: DistrictFrom | null | undefined): boolean => !!from && EXPLICIT_DISTRICT_SOURCES.has(from);

export interface BreakingStory {
  headline: string;
  /** The headline line as the file had it, before a place prefix ("#Kota:", "मेड़तासिटी :") was taken off */
  rawHeadline: string;
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
const NOT_A_PLACE = /बड़ा|बड़ी|बड़े|खबर|हादसा|कार्रवाई|खुलासा|मामला|सनसनी|अपडेट|ब्रेकिंग|एक्सक्लूसिव|विज्ञापन|सूचना|अलर्ट|लाइव|दौरा|बयान|चुनाव|बैठक|हत्या|मौत|आग|फैसला|नियुक्ति|तबादला|पोस्ट|भाजपा|बीजेपी|कांग्रेस/u;

interface Located {
  district: DistrictInfo | null;
  town: string | null;
}

const clean = (line: string) => line.replace(INVISIBLE, "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => s.split(" ").filter(Boolean).length;

/**
 * District names a headline uses as something else, or where the word is wrong far more often than a
 * district usually is. Measured on 2,476 posts (how often a headline with the word really is that district):
 * अजमेर 36% (mostly highway names), सीकर 50%, दौसा 57%, डूंगरपुर 60%; and the everyday words कोटा
 * ("ओबीसी कोटा", quota: 87%), पाली ("दूसरी पाली", a shift: 86%), बूंदी (the sweet). These are inferred only
 * when the word is followed by a strong locative (STRONG_PLACE_AFTER), never by के/का/की or at the end.
 */
export const AMBIGUOUS_DISTRICTS: ReadonlySet<string> = new Set(["Kota", "Pali", "Bundi", "Ajmer", "Sikar", "Dausa", "Dungarpur"]);
/** What follows a district named as the story's own place: "डूंगरपुर में", "डीग के", "जिले" (or the headline ends) */
const PLACE_AFTER: ReadonlySet<string> = new Set(["में", "के", "की", "का", "जिले", "जिला", "स्थित", "शहर"].map(fold));
/** The only followers that make an AMBIGUOUS_DISTRICTS word a place: "डूंगरपुर में", "सीकर जिले के" */
const STRONG_PLACE_AFTER: ReadonlySet<string> = new Set(["में", "जिले", "जिला", "स्थित", "शहर"].map(fold));
const FOR = new Set(["लिए", "लिये"].map(fold));
/**
 * A route or a building carries a district's name without being in it: "अजमेर-जयपुर हाईवे", "जोधपुर रोड",
 * "बीकानेर हाउस" (Delhi), "राजस्थान भवन". The words before the route or building word (joined by hyphens)
 * are taken out of the text before any district is looked for. 9 route headlines in the corpus.
 */
// "अजमेर-जयपुर", "अजमेर - जयपुर" and the space-separated pair "अजमेर जयपुर" before the route word
const NAME_RUN = String.raw`(?<![\p{L}\p{M}])[\p{L}\p{M}]+(?:\s*[-–—]\s*[\p{L}\p{M}]+)*(?:\s+[\p{L}\p{M}]+)?`;
const ROUTE_OR_BUILDING = new RegExp(
  String.raw`${NAME_RUN}\s+(?:नेशनल\s+|राष्ट्रीय\s+|मेगा\s+)?(?:हाईवे|हाइवे|राजमार्ग|मार्ग|रोड|एक्सप्रेसवे|एक्सप्रेस\s*वे|हाउस|भवन)(?![\p{L}\p{M}])`,
  "gu",
);
export const withoutRoutesAndBuildings = (text: string): string => text.normalize("NFC").replace(ROUTE_OR_BUILDING, " ");

/**
 * The one Rajasthan district a headline names as where the story IS, or null. INFERRED, and so only ever a
 * suggestion (b6 fix brief P0): the caller must never put it in line 1 or pick a handle with it. Only when:
 *  - routes and buildings are taken out first ("अजमेर-जयपुर हाईवे", "बीकानेर हाउस");
 *  - exactly one district is named: two are a route, a trip or a comparison;
 *  - it reads as a place: followed by में / के / की / का / जिले ... or ending the headline, and not
 *    "के लिए" (a destination: "खैरथल-तिजारा के लिए रवाना"); an AMBIGUOUS_DISTRICTS word only before a
 *    strong locative ("डूंगरपुर में", "सीकर जिले").
 */
export function inferHeadlineDistrict(book: PlaceBook, headline: string): DistrictInfo | null {
  const text = withoutRoutesAndBuildings(headline);
  const found = book.find(text).filter((m) => m.entry.data.kind === "district" && m.entry.data.districts[0]?.rajasthan);
  const named = [...new Map(found.map((m) => [m.entry.data.districts[0]!.name, m.entry.data.districts[0]!])).values()];
  if (named.length !== 1) return null;
  const d = named[0]!;
  const ambiguous = AMBIGUOUS_DISTRICTS.has(d.tag) || AMBIGUOUS_DISTRICTS.has(d.name);
  // Every place the headline uses one of the district's names, not only the first: "डीग-कुम्हेर विधायक ... पहुंचेंगे डीग"
  const words = fold(text).split(" ").filter(Boolean);
  const aliases = [...new Set(found.map((m) => m.matched))].map((a) => a.split(" ").filter(Boolean));
  for (const alias of aliases) {
    for (let i = 0; i + alias.length <= words.length; i++) {
      if (!alias.every((w, k) => words[i + k] === w)) continue;
      const next = words[i + alias.length];
      if (next === undefined) {
        if (!ambiguous) return d;
        continue;
      }
      if ((ambiguous ? STRONG_PLACE_AFTER : PLACE_AFTER).has(next) && !FOR.has(words[i + alias.length + 1] ?? "")) return d;
    }
  }
  return null;
}

/**
 * The Rajasthan districts the desk TAGGED in a headline ("#BJP #Kota: ...", "#JhalawarNews"), in order, each once.
 * Only Rajasthan districts: "#Pakistan" or "#Delhi" is a topic tag in a Rajasthan desk's copy, not where the story
 * is, and taking it would flip the footer to #FirstIndiaNews. Only the headline: a tag in a point is commentary.
 */
export function headlineDistrictTags(book: PlaceBook, headline: string): DistrictInfo[] {
  const out = new Map<string, DistrictInfo>();
  for (const m of headline.matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)) {
    const raw = m[1]!;
    const p = book.hashtag(raw) ?? (/^.+News$/u.test(raw) ? book.hashtag(raw.slice(0, -4)) : null);
    const d = p && p.kind === "district" ? p.districts[0] : null;
    if (d?.rajasthan) out.set(d.name, d);
  }
  return [...out.values()];
}

/** A district tag in the headline is explicit only when it is the one district tagged: two are a conflict, offered */
function taggedDistrict(book: PlaceBook, headline: string): DistrictInfo | null {
  const tags = headlineDistrictTags(book, headline);
  return tags.length === 1 ? tags[0]! : null;
}

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
  // Hashtags are hashtagPrefix()'s; ones it turned down ("#BJP #Kota", "#Kota #भाजपा") are not glued into a town
  // A party is not a place: "भाजपा: ...", "BJP: ..." stay in the headline, and the party check sees them
  if (!m || words(m[1]!) > 3 || m[1]!.includes("#") || PARTY.test(m[1]!)) return null;
  const place = resolvePlace(book, m[1]!, hint, words(m[1]!) <= 2 && DEVANAGARI.test(m[1]!));
  return place ? { place, rest: m[2]! } : null;
}

/** "#Jhalawar #डग: ...", "#Alwar: ...": one to three hashtags, then the colon */
const HASHTAG_PREFIX = /^((?:#[\p{L}\p{M}\p{N}_]+\s*){1,3})[:：]\s*[-–]?\s*(.*)$/u;

/**
 * The desk's own place tags before the headline, or null when the tags are not all places ("#BJP #Kota:",
 * "#ब्रेकिंग:"): then the prefix stays in the headline, as the desk wrote it. A district tag sets the district (a
 * Rajasthan one over a national place), a town of that district sets the town; a town tag alone brings its
 * district. One unknown one-word Hindi tag after a known district is that district's town ("#Jhalawar #नयागांव:"),
 * as on a place line. The headline is what follows the colon.
 */
function hashtagPrefix(book: PlaceBook, headline: string, hint: string | null): { place: Located; rest: string; conflict: boolean } | null {
  const m = HASHTAG_PREFIX.exec(headline);
  if (!m || PARTY.test(m[1]!)) return null;
  const tokens = m[1]!.split(/[\s#]+/u).filter(Boolean);
  const places = tokens.map((t) => book.hashtag(t));
  const areas = places.filter((p): p is Place => p !== null && p.kind !== "town");
  const area = areas.find((p) => p.kind === "district") ?? areas[0];
  let district = area ? area.districts[0]! : null;
  let town: string | null = null;
  const unknown = places.flatMap((p, i) => (p ? [] : [i]));
  if (unknown.length) {
    const i = unknown[0]!;
    const word = tokens[i]!;
    const newTown = unknown.length === 1 && i === tokens.length - 1 && area?.kind === "district" && DEVANAGARI.test(word) && !/[0-9०-९_]/.test(word) && !NOT_A_PLACE.test(word);
    if (!newTown) return null;
    town = word;
  }
  if (!town) {
    const towns = places.filter((p): p is Place => p !== null && p.kind === "town");
    const known = district ? towns.find((t) => t.districts.some((d) => d.name === district!.name)) : towns[0];
    if (known && !district) district = districtOf(known, hint);
    town = known?.hi ?? null;
  }
  // Tags naming two Rajasthan districts ("#Kota #Jhalawar:", "#Kota #डग:" with डग in Jhalawar): the first stands, flagged
  const conflict = places.some((p) => p !== null && p.kind !== "national" && !p.districts.some((d) => d.name === district?.name));
  return { place: { district, town: town && town !== district?.hi ? town : null }, rest: m[2]!.trim(), conflict };
}

/** First place named in the text: Rajasthan wins over a national place in the same text */
function placeInText(book: PlaceBook, text: string, hint: string | null): { district: DistrictInfo; national: boolean } | null {
  const found = book.find(withoutRoutesAndBuildings(text));
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
    return { headline: "", rawHeadline: "", points: [], district: hint, districtFrom: hint ? "file_code" : null, town: null, rajasthan: hint !== "Delhi", leaderPost: false, deskNote: notes.join("\n") || null, tags, needsCheck };
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
  const rawHeadline = headline;
  const tagged = hashtagPrefix(book, headline, hint);
  if (tagged) {
    if (tagged.conflict) flag("place_conflict");
    // The desk tagged the place itself: its district wins over a place line, the file code and the text
    headline = tagged.rest;
    // "#Jhalawar #डग:" on a line of its own: the headline is the next line
    if (!headline && lines.length > 1) {
      lines = lines.slice(1);
      headline = lines[0]!.replace(BULLET, "");
    }
    const { district: d, town: t } = tagged.place;
    if (d) {
      const sameDistrict = where?.district?.name === d.name;
      // The place line named another district: the desk's tag wins, but a person should look
      if (where?.district && !sameDistrict) flag("place_conflict");
      const placeTown = where?.town && (sameDistrict || book.lookup(where.town)?.districts.some((x) => x.name === d.name)) ? where.town : null;
      where = { district: d, town: t ?? placeTown };
      if (!sameDistrict) from = "headline_prefix";
    }
  }
  const prefix = tagged ? null : headlinePrefix(book, headline, hint);
  /** "आकोला: ..." — one unknown Hindi word before the colon: the desk named the place, so it stays as the town */
  let loneTown: string | null = null;
  if (prefix) {
    headline = prefix.rest;
    if (!prefix.place.district && prefix.place.town && words(prefix.place.town) === 1) loneTown = prefix.place.town;
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
  // One Rajasthan district the desk tagged in its headline is the desk's own word: explicit, like the place line
  if (!district) {
    const tagged = taggedDistrict(book, rawHeadline);
    if (tagged) {
      district = tagged;
      from = "tag";
      national = !tagged.rajasthan;
    }
  }
  // A town on the place line on its own (no district yet): the town's district, if the gazetteer knows the
  // town. The desk wrote the town, so this is explicit, and it outranks the file code
  if (!district && where?.town) {
    const t = book.lookup(where.town);
    if (t) {
      district = districtOf(t, hint);
      from = "place_line";
    }
  }
  // The file code: the FILING desk's district. Stated, as before b6 (it is what put #Jhalawar and @JhalawarPolice
  // on "झालावाड़ में सड़क हादसे में दो घायल"), except for a bureau reporter, which the composer checks (it
  // knows the reporters): Navin files every district's ACB story under JPR.
  if (!district && hint) {
    district = book.district(hint);
    from = "file_code";
    national = !!district && !district.rajasthan;
  }
  // Everything below is INFERRED (b6 fix brief P0): stored for the queue and its filters, only ever offered
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

  // A town tag without its district reads oddly ("#सचिवालय:"): keep it only with a district, or when the desk wrote it
  // before the headline's colon ("आकोला: ..."); no_district still asks the desk to look
  const town = (district || (where?.town && where.town === loneTown)) && where?.town && where.town !== district?.hi ? where.town : null;
  return {
    headline,
    rawHeadline,
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
