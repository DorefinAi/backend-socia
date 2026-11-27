// The newsroom's breaking .txt files: line 1 repeats the file name; then an optional place line
// ("जयपुर", "जोधपुर से खबर", "दौसा के बांदीकुई से खबर", "करौली से <reporter> की रिपोर्ट"); then the
// headline; then one point per line. Desk instructions ("नोट-: ... फुलस्क्रीन करावें") are taken out and
// flagged. Rules only: anything odd is flagged for a human, never guessed by a model.

import { fold } from "../fold";
import { fileTags, fromNationalDesk, isNationalFlash, type FileTags } from "./filename";
import type { DistrictInfo, Place, PlaceBook } from "./places";
import { openingPlaceLength, placeMatchKey, placeWordInCompound } from "./place-match";
import { RAJASTHAN_DISTRICTS } from "../rajasthan";

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
  /** The file was taken, then deleted from the share (the desk removed it mid-edit or by mistake): check the FTP. Set and cleared by the ingest scan */
  "file_deleted",
  /** A word or number of the file is missing from the story (a rule changed the desk's text): check against the file before posting */
  "text_changed",
  /** A national story naming no place: the composer added no city hashtag (b9 D4); the desk picks one. Set by the composer */
  "no_city",
  /** A national story (#FirstIndiaNews) carrying no city: no Rajasthan city is added, the state tag is offered (P3). Set by the composer */
  "national_story",
] as const;
/** Set by the ingest stage, not the parser: they survive a re-parse */
export const STICKY_CHECKS: readonly NeedsCheck[] = ["resaved", "update_of_posted"];
export type NeedsCheck = (typeof NEEDS_CHECK)[number];
/** These make the queue's "needs review" flag; the others are worth a look but usually fine */
export const SERIOUS_CHECKS: readonly NeedsCheck[] = ["empty", "no_headline", "no_hindi", "very_long", "text_changed"];

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
 *   headline_lead    another Rajasthan district the headline (or the first point) opens with, or names as "X शहर",
 *                    where the file code says otherwise: the desk's own words beat the code (P9, 25 Nov 2026) — explicit
 *   text             a place the headline or the first points mention — inferred
 */
export type DistrictFrom = "place_line" | "headline_prefix" | "tag" | "headline_lead" | "file_code" | "text";
/** Explicit whoever filed it. file_code is explicit too, but only for a reporter tied to one district (storyDistrict). */
export const EXPLICIT_DISTRICT_SOURCES: ReadonlySet<DistrictFrom> = new Set<DistrictFrom>(["place_line", "headline_prefix", "tag", "headline_lead"]);
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

/** "नोट-:", "नोट :-", "NOTE :": a desk note always starts this way (all 340 in the 10,564 stored files). "नोट और दारू" (bank notes) is news. */
const NOTE_START = /^(?:नोट|note)\s*[-:–—ः]+/iu;
/** The marker followed by a space ("नोट :- ...", "नोटः ...") */
const NOTE_START_SPACED = /^(?:नोट|note)\s*[-:–—ः]+(?:\s|$)/iu;
/** What every desk note asks for (all 340 stored ones); "नोट-बंदी के बाद बाजार में रौनक" asks for nothing: news */
const DESK_INSTRUCTION = /फोटो|फुल\s*स्क्रीन|full\s*screen|विजुअल|visual|करावें|कराएं|करवाएं|चलाएं|चलावें/iu;
/** The TV control room's full-screen label line: "FULL_<file number>_<copy of a line below>" (any case) */
const FULL_LABEL = /^full_\d+_\s*(.*)$/iu;
/** A FULL_ label's text counts as a copy of a line below only when it is at least this long (letters, placeMatchKey) */
const FULL_COPY_MIN_LETTERS = 4;
/**
 * A section label line above the headline that the desk never posts: "बर्थ-डे" (birthday files; their posts lead with
 * "<name> का जन्मदिन आज"). Taken off on purpose. Labels the desk DOES post ("सियासी गपशप !") stay as the headline.
 */
const SECTION_LABEL = /^(?:बर्थ\s*-?\s*डे|बर्थडे|birth\s*-?\s*day)[\s!।.]*$/iu;
/** A line that is nothing but a fullscreen instruction ("फोटो के साथ फुलस्क्रीन करावें"): never a news line that only mentions it */
const FULLSCREEN_ONLY = /(?:फुल\s*स्क्रीन\s*(?:करावें|कराएं|करें|कराये|चलावें|चलाएं)|full\s*screen\s+(?:only|karayen))[\s।.!]*$/iu;
/**
 * A desk instruction, taken out of the post (owner, 17 Nov 2026: a news line is never taken out because it MENTIONS
 * fullscreen): a line starting "नोट :-" / "NOTE :" (marker then a space), or "नोट---हाईकोर्ट की फोटो ..." (marker
 * glued to the word) when it asks for a photo or fullscreen; or a line of at most 20 words that ENDS in the instruction.
 */
export const isDeskNote = (line: string): boolean =>
  NOTE_START_SPACED.test(line) || (NOTE_START.test(line) && DESK_INSTRUCTION.test(line)) || (FULLSCREEN_ONLY.test(line) && words(line) <= 20) ||
  (DESK_ORDER.test(line) && DESK_ORDER_SUBJECT.test(line) && words(line) <= 15);
/**
 * P8 (owner, 25 Nov 2026): a short line that ORDERS the control room ("ED के दफ्तर की फोटो के साथ फुल स्क्रीन कराए" leaked into
 * a post as its headline): it names a photo, fullscreen, visual, graphic, video or byte, and ends in the order itself
 * (कराएं / कराए / चलाएं / लगाएं / दिखाएं …). A news line that only mentions such a thing does not end that way.
 */
const DESK_ORDER = /(?:कराव?ें|कराएं|कराए|कराये|करायें|करवाएं|करवाए|करवावें|चलावें|चलाएं|चलाए|चलाये|लगावें|लगाएं|लगाए|दिखावें|दिखाएं|दिखाए)[\s।.!]*$/u;
const DESK_ORDER_SUBJECT = /फोटो|फुल\s*स्क्रीन|स्क्रीन|full\s*screen|विजुअल|विज़ुअल|visual|ग्राफिक्स?|ग्राफिक|वीडियो|बाइट|byte/iu;
/**
 * A line that does not finish its sentence: the next line continues it. A comma or a conjunction; or a stub of at most
 * two words ending in a postposition ("जयपुर के" / "बिरला ऑडिटोरियम में ...", one line broken in two: owner, 17 Nov
 * 2026). A longer line ending in के / की / का is a whole line in the desk's style ("... की मांग की", "बिना हेलमेट के").
 */
const CONTINUES = /(?:,|，|\s(?:और|एवं|तथा|व))$|^\S+\s+(?:के|की|का|में|से)$/u;
/**
 * A list marker before a line's text, taken off: a symbol bullet, or a dash / ">" that is not a number's sign.
 * Never a number: "1.", "85.59", "1.11.2026", "-2.5 डिग्री", ">50 लोग" stay exactly as the desk wrote them (owner,
 * 17 Nov 2026: "85.59 प्रतिशत" had become "59 प्रतिशत" when "85." was taken for a list number).
 */
// The whole run of dashes / ">" is one marker or none (no backtracking: "--5 लोग" stays as written)
const BULLET = /^(?:[•●▪■◆➤►*]+|[-–—]+(?![-–—])(?!\s*\p{N})|>+(?!>)(?!\s*\p{N}))\s*/u;
/**
 * A word of a line, for the text-kept check: a run of letters with their marks, or a number with its decimals, date
 * dots or time colon ("85.59", "1.11.2026", "3:30"). "आकोला:100" is two words, as the parser splits it.
 */
const TOKEN = /[\p{L}\p{M}]+|\p{N}+(?:[.,:]\p{N}+)*/gu;
const tokensOf = (text: string): string[] => [...text.normalize("NFC").matchAll(TOKEN)].map((m) => m[0]);
/**
 * The words of `fileLines` that the story does not have, counted (a word the file has twice must appear twice):
 * file minus what was taken off on purpose (`removed`: whole lines and the place words before the headline) minus the
 * story's own text. Empty when every word arrived. Exported for the tests of the safety net itself.
 */
export function lostWords(fileLines: readonly string[], removed: readonly string[], story: readonly string[]): string[] {
  const count = new Map<string, number>();
  const add = (text: string, by: number) => {
    for (const t of tokensOf(text)) count.set(t, (count.get(t) ?? 0) + by);
  };
  for (const l of fileLines) add(l, 1);
  for (const l of removed) add(l, -1);
  for (const l of story) add(l, -1);
  return [...count].filter(([, n]) => n > 0).map(([t]) => t);
}
/**
 * A line with nothing to say: no letter or number at all ("----", "****", "."), or a stray keystroke ("ब्", a lone "x").
 * A one-letter Hindi word ("ॐ", "है") is text. (In the 10,564 stored files the only such line is ".".)
 */
const isSeparator = (line: string): boolean => !/[\p{L}\p{N}]/u.test(line) || /^\p{L}्$/u.test(line) || /^[A-Za-z]$/.test(line);
/** "<leader> की पोस्ट" / "... ने दी शुभकामनाएं": the headline is a leader's own post */
export const LEADER_POST = /(?:की|का)\s+(?:पोस्ट|ट्वीट|ट्विट|बयान)$|ने\s+(?:दी|दीं)\s+(?:शुभकामनाएं|शुभकामनाएँ|बधाई|श्रद्धांजलि)$|ने\s+कहा$/u;

/** State-level news: the capital's desk, no district to tag */
const STATEWIDE = /राजस्थान|प्रदेश|राज्य|सचिवालय|मुख्यमंत्री|सीएम|मुख्य\s*सचिव|(?<![A-Za-z])(?:IAS|ACS|RAS)(?![A-Za-z])|विधानसभा|मंत्रिमंडल|कैबिनेट/u;

/** "<place> से (बड़ी) खबर" / "<place> में खबर" */
// Also the desk's slips "चूरू के खबर", "अजमेर के केकड़ी खबर" (no से) and "बीकानेर से दुखद खबर" (17 Nov 2026)
const PLACE_NEWS = /^(.+?)\s+(?:(?:से|में|के)\s+)?(?:(?:इस\s+वक्त|अभी)(?:\s+की)?\s+)?(?:(?:बड़ी|ताजा|ताज़ा|अहम|खास|दुखद|दर्दनाक|सनसनीखेज|अच्छी|राहत\s+भरी)\s+)?ख़?ख?बर$/u;
/** A postposition inside a phrase: such a phrase is a sentence fragment, never a town's name ("उदयपुरवाटी से दर्दनाक") */
const HAS_POSTPOSITION = /(?:^|\s)(?:से|में|की|का|के|को|पर|ने)(?:\s|$)/u;
/** "<place> से <reporter> की (एक्सक्लूसिव) रिपोर्ट/खबर" */
const PLACE_BYLINE = /^(.+?)\s+से\s+.+?\s+की\s+(?:एक्सक्लूसिव\s+|खास\s+|विशेष\s+)?(?:रिपोर्ट|खबर)$/u;
/** "<reporter> की (एक्सक्लूसिव) रिपोर्ट": a byline with no place */
const BYLINE = /^.{2,60}\s+की\s+(?:एक्सक्लूसिव\s+|खास\s+|विशेष\s+)?रिपोर्ट$/u;
/** "रेनवाल (जयपुर)", "अंता(बारां)" */
const TOWN_IN_BRACKETS = /^(.+?)\s*\((.+?)\)$/u;
/**
 * Words that a one-word line can be without being a place. WHOLE words only (C-b): "बड़ागांव" and "आगोलाई" are
 * places, not "बड़ा…" or "आग…". The plural and compound forms the old substring match caught are listed outright.
 */
const NOT_A_PLACE_WORDS: ReadonlySet<string> = new Set(
  [
    "बड़ा", "बड़ी", "बड़े", "खबर", "खबरें", "हादसा", "हादसे", "कार्रवाई", "खुलासा", "मामला", "मामले", "सनसनी", "अपडेट", "ब्रेकिंग",
    "एक्सक्लूसिव", "विज्ञापन", "सूचना", "अलर्ट", "लाइव", "दौरा", "दौरे", "बयान", "चुनाव", "चुनावी", "चुनावों", "बैठक", "बैठकें", "हत्या",
    "हत्याकांड", "मौत", "आग", "आगजनी", "फैसला", "फैसले", "नियुक्ति", "तबादला", "तबादले", "पोस्ट", "भाजपा", "बीजेपी", "कांग्रेस", "न्यूज",
    // Labels the desk writes before a colon (owner, 17 Nov 2026: "आरोप: ..." had become a town tag "#आरोप")
    "आरोप", "मांग", "अपील", "चेतावनी", "निर्देश", "दावा", "सवाल", "जवाब", "राहत", "झटका", "गपशप", "सियासी", "सियासत", "प्रदर्शन",
    "विरोध", "धरना", "हड़ताल", "घोषणा", "परिणाम", "नतीजे", "रिपोर्ट", "वारदात", "प्रतिक्रिया", "श्रद्धांजलि", "बधाई", "सम्मान",
    "कार्यक्रम", "आयोजन", "अभियान", "उपलब्धि", "जानकारी", "आदेश", "कार्रवाई", "बड़ीखबर", "ब्रेकिंगन्यूज",
    "भूकंप", "सावधान", "नतीजा", "सनसनीखेज", "खुशखबरी", "दुखद", "शर्मनाक", "चौंकाने",
  ].map(fold),
);
/** A word made only of NOT_A_PLACE_WORDS, joined as in a hashtag ("बड़ीखबर", "ब्रेकिंगन्यूज़"); never a part of a word */
function labelRun(word: string, from = 0): boolean {
  if (from === word.length) return from > 0;
  for (const w of NOT_A_PLACE_WORDS) if (word.startsWith(w, from) && labelRun(word, from + w.length)) return true;
  return false;
}
/** Whether a short phrase is not a place: one of its whole words is a NOT_A_PLACE word (or a run of them) */
export const notAPlace = (phrase: string): boolean => fold(phrase).split(" ").some((w) => !!w && labelRun(w));

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

/** "#JodhpurNews", "#Jodhpur_News", "#जोधपुरन्यूज़", "#जोधपुरन्यूज", "#जोधपुरसमाचार": the place a "<Place>News" tag names */
const NEWS_STEM = /^(.+?)_?(?:News|NEWS|news|न्यूज़?|समाचार)$/u;
/**
 * The place a hashtag names, its "<Place>News" form included, Latin or Hindi (C-c). One reading for the headline's
 * district tags here and for composeBreaking's "the desk tagged a place" check, so the two never disagree.
 */
export function placeOfTag(book: PlaceBook, raw: string): Place | null {
  const t = raw.normalize("NFC");
  const stem = NEWS_STEM.exec(t)?.[1];
  return book.hashtag(t) ?? (stem ? book.hashtag(stem) : null);
}

/**
 * For the replay reference (post-tags.ts PostTagContext.hindiPlace): the Latin tag of the district or national place a
 * Hindi name is ("जोधपुर" → "Jodhpur"), so "#जोधपुरन्यूज़" reads there as "#JodhpurNews". A town has no Latin tag on
 * districts.json: null.
 */
export const hindiPlaceTag = (book: PlaceBook) => (name: string): string | null => {
  const p = book.hashtag(name);
  return p && p.kind !== "town" ? (p.districts[0]?.tag ?? null) : null;
};

/**
 * The Rajasthan districts the desk TAGGED in a headline ("#BJP #Kota: ...", "#JhalawarNews", "#जोधपुरन्यूज़"), in order, each once.
 * Only Rajasthan districts: "#Pakistan" or "#Delhi" is a topic tag in a Rajasthan desk's copy, not where the story
 * is, and taking it would flip the footer to #FirstIndiaNews. Only the headline: a tag in a point is commentary.
 */
export function headlineDistrictTags(book: PlaceBook, headline: string): DistrictInfo[] {
  const out = new Map<string, DistrictInfo>();
  for (const m of headline.normalize("NFC").matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)) {
    const p = placeOfTag(book, m[1]!);
    const d = p && p.kind === "district" ? p.districts[0] : null;
    if (d?.rajasthan) out.set(d.name, d);
  }
  return [...out.values()];
}

/**
 * After a place word: from, up to, to, for ("से", "तक", "को", "के लिए"): the place is an origin or a destination; a comma
 * or "और" makes it the first of a list ("कोटा, बारां, करौली और श्रीगंगानगर में…"), not the story's place
 */
/** "<place> से <reporter> की (एक्सक्लूसिव / Exclusive) रिपोर्ट / Report / खबर": a byline names where the story is */
const BYLINE_AFTER = /^\s*से\s+.{2,40}?\s+की\s+(?:\S+\s+)?(?:रिपोर्ट|खबर|report|story)(?![\p{L}\p{M}])/iu;
const LEAD_AWAY =/^\s*(?:[,،]|(?:से|तक|को|के\s+लिए|की\s+ओर|और|व|एवं|तथा)(?![\p{L}\p{M}]))/u;

/**
 * P9: the Rajasthan district the headline OPENS with, in any spelling ("बालोतरा शहर के…", "खैरथल के किशनगढ़बास में…"), never
 * a place word inside a compound or route ("जयपुर-दिल्ली हाईवे", "अजमेर रोड पर"), an origin or destination, or a list's first;
 * else the district the headline names as "<district> शहर". Null when none. The first point is NOT read: on the 2,271
 * posts of 15–24 Nov a first point opening with another district changed 2 posts, both away from the desk's city.
 */
export function leadDistrict(book: PlaceBook, headline: string): DistrictInfo | null {
  const text = headline.normalize("NFC").trim();
  let best: DistrictInfo | null = null;
  let len = 0;
  for (const d of book.districts) {
    if (!d.rajasthan) continue;
    // rajasthan.ts's other Hindi names count: "खैरथल के किशनगढ़बास में…" opens with Khairthal-Tijara
    const other = RAJASTHAN_DISTRICTS.find((r) => r.name === d.name)?.aliases.filter((a) => DEVANAGARI.test(a)) ?? [];
    const k = openingPlaceLength(text, [...book.spellingsOf(d.name), d.hi, ...other]);
    if (k > len) [best, len] = [d, k];
  }
  // A route or building keeps its words ("अजमेर रोड पर हादसा"): no longer the opening once they are taken out
  const route = best && !withoutRoutesAndBuildings(text).trimStart().startsWith(text.slice(0, len));
  // Where someone comes from or goes to is not where the story is ("उदयपुर से लौट रहे जयपुर के परिवार…", "… के लिए"); a byline
  // is ("खैरथल-तिजारा से हेमसिंह परमार की Exclusive Report": the hyphen is the district's own name, no route)
  const away = best && LEAD_AWAY.test(text.slice(len)) && !BYLINE_AFTER.test(text.slice(len));
  if (best && !placeWordInCompound(text, len) && !route && !away) return best;
  for (const m of headline.normalize("NFC").matchAll(/([\p{L}\p{M}]+)\s+शहर(?![\p{L}\p{M}])/gu)) {
    const p = book.lookup(m[1]!);
    if (p?.kind === "district" && p.districts[0]?.rajasthan) return p.districts[0];
  }
  return null;
}

/**
 * P11 (owner, 25 Nov 2026): a statewide list story, a ranking or a roundup ("सीकर ने 90 अंकों के साथ…, झुंझुनूं 86…,
 * कोटपूतली-बहरोड़ तीसरे…"): the lines given (the first two points) name three or more Rajasthan districts (routes and buildings
 * aside). No district is inferred from those lines; a district the headline itself names still is.
 */
export const LIST_STORY_DISTRICTS = 3;
export function isListStory(book: PlaceBook, lines: readonly string[]): boolean {
  const named = new Set<string>();
  for (const line of lines) {
    for (const m of book.find(withoutRoutesAndBuildings(line))) {
      const d = m.entry.data;
      if (d.kind === "district" && d.districts[0]?.rajasthan) named.add(d.districts[0].name);
    }
  }
  return named.size >= LIST_STORY_DISTRICTS;
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

  // "शाहबाद बारां", "मंडावा, झुंझुनूं": a town the places file knows (or, where an unknown town is allowed, one Hindi
  // word) then its district
  const townThenDistrict = /^(.+?)[,\s]+([^\s,]+)$/u.exec(p);
  if (townThenDistrict && words(townThenDistrict[1]!) <= 2) {
    const d = book.lookup(townThenDistrict[2]!);
    const t = book.lookup(townThenDistrict[1]!);
    const unknownOk = allowUnknownTown && words(townThenDistrict[1]!) === 1 && DEVANAGARI.test(townThenDistrict[1]!) && !notAPlace(townThenDistrict[1]!);
    if (d && d.kind === "district" && (t?.kind === "town" || unknownOk)) return { district: d.districts[0]!, town: t?.hi ?? townThenDistrict[1]!.trim() };
  }
  const pair = /^(.+?)\s+(?:जिले\s+)?(?:के|से|का|की)\s+(.+)$/u.exec(p) ?? swap(TOWN_IN_BRACKETS.exec(p));
  if (pair) {
    const outer = book.lookup(pair[1]!.replace(/\s+जिले?$/u, ""));
    const inner = book.lookup(pair[2]!);
    // "आबूरोड से रेलवे की", "जयपुर से इस वक्त": a second half that is not a place we know and reads as words (a label,
    // a postposition inside) means this is no dateline: the line stays as the desk wrote it, no word lost
    if (!inner && (notAPlace(pair[2]!) || HAS_POSTPOSITION.test(pair[2]!) || /(?:^|\s)(?:इस|अभी|वक्त)(?:\s|$)/u.test(pair[2]!))) return null;
    if (outer && outer.kind !== "town") {
      // "दौसा से सियासी गपशप", "उत्तर प्रदेश की सियासत": the second half is a label, not a town, so this is no dateline
      // and the line stays as the desk wrote it (owner, 17 Nov 2026; the desk posts "जालोर से सियासी गपशप" as the headline)
      if (!inner && (notAPlace(pair[2]!) || HAS_POSTPOSITION.test(pair[2]!))) return null;
      const town = inner?.hi ?? (words(pair[2]!) <= 3 && DEVANAGARI.test(pair[2]!) ? pair[2]! : null);
      return { district: outer.districts[0]!, town: town && town !== outer.hi ? town : null };
    }
    if (inner) return located(inner, null, outer ? districtOf(outer, hint).name : hint);
    if (outer) return located(outer, null, hint);
  }
  if (allowUnknownTown && words(p) <= 2 && DEVANAGARI.test(p) && !/[0-9:]/.test(p) && !notAPlace(p)) return { district: null, town: p };
  return null;
}

/** Edit distance between two short strings (code points) */
function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
}

/** A misspelt dateline town is corrected only when it is at least this long (letters, as placeMatchKey keys them) */
const MISSPELT_MIN_LETTERS = 4;

/** The same letters, in any order ("कुमाचन" and "कुचामन") */
const sameLetters = (a: string, b: string) => [...a].sort().join("") === [...b].sort().join("");

/**
 * The headline's spelling of an unknown dateline town, held tight (owner, 25 Nov 2026: no town may be guessed wrong). Only
 * a known TOWN that the headline OPENS with, starting with the same letter, and either the same letters reordered ("कुमाचन"
 * over "कुचामन पंचायत समिति…") or one letter off. Anything else, a district or a place further in the headline: null, and the
 * desk's word stands as written.
 */
function headlineSpelling(book: PlaceBook, town: string, headline: string): string | null {
  const key = placeMatchKey(town);
  const letters = [...key];
  if (letters.length < MISSPELT_MIN_LETTERS) return null;
  const first = book.find(headline)[0];
  const place = first?.entry.data;
  if (!place || place.kind !== "town" || !openingPlaceLength(headline, [place.hi])) return null;
  const k = placeMatchKey(place.hi);
  if (k === key || [...k][0] !== letters[0]) return null;
  return sameLetters(k, key) || editDistance(k, key) === 1 ? place.hi : null;
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
  // Owner, 17 Nov 2026: a line is taken off the top only when it is a dateline (a place). Anything else stays in
  // the story as the desk wrote it, so no words of the file are lost. A byline is not taken off: the desk posts it
  // as the headline ("#Jaipur: ACB से नवीन शर्मा की रिपोर्ट", "जोधपुर से राजीव गौड़ की रिपोर्ट"); bylinePlace reads
  // its place for the tags and the line stays.
  if (PLACE_BYLINE.test(line) || BYLINE.test(line)) return null;
  const news = PLACE_NEWS.exec(line);
  // "परिवहन विभाग से बड़ी खबर" is a headline in the house style; only a place (or one unknown word) is a place line
  if (news) return resolvePlace(book, news[1]!, hint, words(news[1]!) === 1);
  // A bare place line: a known place, or ONE unknown word ("मासलपुर"); two unknown words ("सियासी गपशप") are text
  if (words(line) <= 4) return resolvePlace(book, line, hint, words(line) === 1);
  return null;
}

/**
 * "<place> से <name> की रिपोर्ट": the place a byline names, read for the district and town; the byline itself stays
 * as the headline (the desk posts it). A name only, or a place we cannot read: null.
 */
function bylinePlace(book: PlaceBook, line: string, hint: string | null): Located | null {
  const m = PLACE_BYLINE.exec(line);
  return m && words(line) <= 9 ? resolvePlace(book, m[1]!, hint, false) : null;
}

/** "मेड़तासिटी : पंच व सरपंच के चुनाव कल" → the place, and the headline without it */
function headlinePrefix(book: PlaceBook, headline: string, hint: string | null): { place: Located; rest: string } | null {
  const m = /^([^:：]{2,30}?)\s*[:：]\s*[-–]?\s*(.+)$/u.exec(headline);
  // Hashtags are hashtagPrefix()'s; ones it turned down ("#BJP #Kota", "#Kota #भाजपा") are not glued into a town
  // A party is not a place: "भाजपा: ...", "BJP: ..." stay in the headline, and the party check sees them
  if (!m || words(m[1]!) > 3 || m[1]!.includes("#") || PARTY.test(m[1]!)) return null;
  // A known place, or ONE unknown Hindi word made of letters only ("आकोला:"), is the desk's place; anything else
  // ("विधायक बोले:", "आरोप:", "‘बिलॉन्गिंग:") stays in the headline (owner, 17 Nov 2026: no words dropped)
  const oneWord = words(m[1]!) === 1 && /^[\p{Script=Devanagari}\p{M}]+$/u.test(m[1]!);
  const place = resolvePlace(book, m[1]!, hint, oneWord);
  return place ? { place, rest: m[2]! } : null;
}

/**
 * The words before the headline's colon when the parser reads them as a place the desk wrote ("रामपुरा खुर्द:",
 * "आकोला:", "कोटा:"), else null: a hashtag run, a party or election word, a label ("बड़ी खबर:", "ब्रेकिंग:") or
 * anything not place-shaped is not one. The parser itself still drops an unknown two-word prefix from the headline
 * (to be revisited after a replay); this only lets the composer see that the desk named a place there.
 */
export function deskPlacePrefix(book: PlaceBook, headline: string): string | null {
  const h = clean(headline.normalize("NFC"));
  // Place-SHAPED, as before 17 Nov: a known place or one or two unknown Hindi words ("रामपुरा खुर्द:"). The parser now
  // keeps such words in the headline (it removes only a known place or one word), but they still tell the composer
  // the desk named a place there, so a reporter's "#Jaipur:" is not put in front of them.
  const m = /^([^:：]{2,30}?)\s*[:：]\s*[-–]?\s*(.+)$/u.exec(h);
  if (!m || words(m[1]!) > 3 || m[1]!.includes("#") || PARTY.test(m[1]!)) return null;
  return resolvePlace(book, m[1]!, null, words(m[1]!) <= 2 && DEVANAGARI.test(m[1]!)) ? m[1]!.trim() : null;
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
    const newTown = unknown.length === 1 && i === tokens.length - 1 && area?.kind === "district" && DEVANAGARI.test(word) && !/[0-9०-९_]/.test(word) && !notAPlace(word);
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

/**
 * The Prime Minister or the union cabinet as a story's subject (owner, 25 Nov 2026). A Rajasthan leader who is a union
 * minister (शेखावत, मेघवाल) is caught by rajasthanSignal first, so their stories stay Rajasthan.
 */
const UNION_LEADER =
  /(?<![\p{L}\p{M}])(?:(?:PM|पीएम|प्रधानमंत्री)\s*(?:नरेंद्र\s*|नरेन्द्र\s*)?मोदी|नरेंद्र\s*मोदी|नरेन्द्र\s*मोदी|(?:केंद्रीय|केन्द्रीय)\s*(?:कैबिनेट|मंत्रिमंडल))(?![\p{L}\p{M}])/u;
/** The Centre in general ("केंद्र सरकार", "मोदी सरकार", "केंद्रीय मंत्री"): national only on a file no Rajasthan reporter filed */
const UNION_BODY = /(?<![\p{L}\p{M}])(?:मोदी\s*सरकार|(?:केंद्र|केन्द्र)\s*सरकार|(?:केंद्रीय|केन्द्रीय)\s*(?:मंत्री|सरकार))(?![\p{L}\p{M}])/u;
/** The file names a reporter who is not known to work only outside Rajasthan (no roster: a reporter counts as Rajasthan's) */
function rajasthanReporter(tags: FileTags, book: PlaceBook, reporterDistricts: readonly string[] | undefined): boolean {
  if (!tags.reporter) return false;
  return !reporterDistricts?.length || reporterDistricts.some((d) => book.district(d)?.rajasthan !== false);
}

/**
 * A story no district was found for: is it national news (#FirstIndiaNews)? Files from the NWS desk are. The
 * national flash (nat_flash_rj_..., owner 17 Nov 2026, rule b: "#RajasthanWithFirstIndia unless the story is about
 * Delhi or another state"), checked on 16 Nov's 116 flash posts:
 *   1. says राजस्थान: Rajasthan (also about Rajasthan, e.g. an RCA team playing another state);
 *   2. names a place outside Rajasthan (Delhi, another state, abroad): national;
 *   3. filed by a reporter whose districts are all outside Rajasthan (`reporterDistricts`, the composer's roster:
 *      the Delhi correspondent's COP31 story names no place): national;
 *   4. no reporter (the TV desk's national wire, e.g. a Delhi rally that never says दिल्ली): national;
 *   5. otherwise (a Rajasthan reporter's flash): Rajasthan.
 * parseBreaking (no roster) and the composer both read it.
 */
export function nationalWithoutPlace(tags: FileTags | null | undefined, text: StoryText, book: PlaceBook, reporterDistricts?: readonly string[]): boolean {
  if (!tags) return false;
  const lines = storyLines(text);
  // The NWS desk's files are national, as before 25 Nov (the desk posts them #FirstIndiaNews, its Rajasthan columns too): a
  // Rajasthan place in the headline or first points gives the parser a district before this is asked
  if (tags.other.includes("NWS") && !isNationalFlash(tags)) return true;
  // P3 (owner and lead, 25 Nov 2026): anything of Rajasthan's in the story (a place anywhere, an institution, a Rajasthan
  // leader as the subject, the desk's own Hindi place tag) keeps it Rajasthan: the desk posts Pilot's Punjab trip and
  // Gehlot's Delhi visit #RajasthanWithFirstIndia
  if (rajasthanSignal(book, lines)) return false;
  // Rule 2 for EVERY file: the headline or the first point names a place outside Rajasthan ("यूपी चुनाव को लेकर बड़ी खबर",
  // "बिहार के वैशाली में PM मोदी"). A place named only further down never flips a story (as before 25 Nov)
  if (outsideInLead(book, lines)) return true;
  // The Centre is the subject of the headline, and nothing in the story is Rajasthan's ("कैबिनेट फैसलों
  // पर PM मोदी का X पर पोस्ट" about an airport in Assam, owner 25 Nov 2026): national, like the desk posts it. The Prime
  // Minister or the union cabinet always; the plain Centre ("केंद्र सरकार", "केंद्रीय मंत्री") only on a file no Rajasthan
  // reporter filed, since a village story may name the Centre's scheme and no place we know
  // The HEADLINE only: the Prime Minister named in a point is often a guest of a Rajasthan story ("DGP Conference… प्रधानमंत्री
  // नरेंद्र मोदी, गृह मंत्री अमित शाह…" went out #Jaipur on 23 Nov)
  const head = lines[0] ?? "";
  if (UNION_LEADER.test(head)) return true;
  if (UNION_BODY.test(head) && !rajasthanReporter(tags, book, reporterDistricts)) return true;
  if (isNationalFlash(tags)) {
    // The flash keeps its own rule 2 on the whole text (17 Nov 2026)
    if (placeInText(book, lines.join(" । "), null)?.national) return true;
    if (reporterDistricts?.length && reporterDistricts.every((d) => book.district(d)?.rajasthan === false)) return true;
    return !tags.reporter;
  }
  return fromNationalDesk(tags);
}

/** A story's text: its lines (headline first, then the points), or the old joined form ("headline । point\npoint") */
export type StoryText = string | readonly string[];
const storyLines = (text: StoryText): string[] =>
  (typeof text === "string" ? text.split(/\s+।\s+|\n/u) : [...text]).map((l) => l.normalize("NFC").trim()).filter(Boolean);

/** P3: no Rajasthan signal anywhere, and the headline or first point names a place outside Rajasthan */
export function namesOnlyOutsidePlace(book: PlaceBook, text: StoryText): boolean {
  const lines = storyLines(text);
  return !rajasthanSignal(book, lines) && outsideInLead(book, lines);
}
/** Rajasthan's own houses in Delhi ("बीकानेर हाउस", "जोधपुर हाउस"): a story there is the state's news, not Delhi's */
const RAJASTHAN_HOUSE = /(?:बीकानेर|जोधपुर|जयपुर|उदयपुर)\s*हाउस/u;
/** Rajasthan's own institutions (lead, 25 Nov 2026): its ACB, RPSC, staff board, RAS, secretariat */
const RAJASTHAN_INSTITUTION = /(?<![A-Za-z])(?:ACB|RPSC|RSSB|RSMSSB|RAS)(?![A-Za-z])|एसीबी|आरपीएससी|सचिवालय/u;
/**
 * Rajasthan's leaders as a story's subject (subject-handles.json: the state government, the Speaker and opposition, the
 * party chiefs, the state's own MPs and union ministers): their trips to Delhi or Punjab are still Rajasthan news
 */
const RAJASTHAN_LEADER =
  /गहलोत|सचिन\s+पायलट|भजनलाल|भजन\s+लाल|डोटासरा|जूली|राठौड़|वसुंधरा|वसुन्धरा|बेनीवाल|पूनिया|दीया\s+कुमारी|दिया\s+कुमारी|किरोड़ी|बैरवा|खींवसर|दिलावर|देवनानी|बागडे|मेघवाल|ओम\s+बिरला|ओम\s+बिड़ला|शेखावत|श्रीनिवास(?![\p{L}\p{M}])|खर्रा|गोदारा|जोगाराम|(?<![\p{L}\p{M}])रोत(?![\p{L}\p{M}])/u;

/**
 * Anything of Rajasthan's in the story: "राजस्थान", a Rajasthan district or town anywhere (route names included: "कालाडेरा
 * रेनवाल रोड" is in Jaipur), one of its houses in Delhi, its institutions (ACB, RPSC, सचिवालय, its विधानसभा), one of its
 * leaders, or the desk's own unknown Hindi place tag leading the headline ("#कालाडेरा:", "#सियोल:" on the Chief Secretary's trip)
 */
function rajasthanSignal(book: PlaceBook, lines: readonly string[]): boolean {
  const all = lines.join(" । ");
  if (/राजस्थान/u.test(all) || RAJASTHAN_HOUSE.test(all) || RAJASTHAN_INSTITUTION.test(all)) return true;
  // A leader is the SUBJECT in the headline or the first point; one congratulating in the body is not ("CM भजनलाल ने दी बधाई"
  // under a union minister's birthday)
  if (RAJASTHAN_LEADER.test(lines.slice(0, 2).join(" । "))) return true;
  if (book.find(all).some((m) => m.entry.data.kind !== "national" && m.entry.data.districts.some((d) => d.rajasthan))) return true;
  // "विधानसभा", unless another state's ("दिल्ली विधानसभा", "बिहार विधानसभा चुनाव")
  for (const m of all.matchAll(/([\p{L}\p{M}]+)\s+विधानसभा|(?:^|[^\p{L}\p{M}])विधानसभा/gu)) {
    if (!m[1] || book.lookup(m[1])?.kind !== "national") return true;
  }
  const lead = /^#([\p{L}\p{M}]+)\s*[:：]?/u.exec(lines[0] ?? "")?.[1];
  return !!lead && DEVANAGARI.test(lead) && !PARTY.test(lead) && !notAPlace(lead) && book.hashtag(lead)?.kind !== "national";
}

/** P3: the headline or the first point names a place outside Rajasthan (routes and buildings aside) */
function outsideInLead(book: PlaceBook, lines: readonly string[]): boolean {
  return lines.slice(0, 2).some((l) => !!placeInText(book, l, null)?.national);
}

/**
 * The post's brand as the worker decides it, one rule for the worker, the replay and the tests: a stated place decides
 * (stories.district: a Rajasthan district or a national place); with none, nationalWithoutPlace on the text (its lines), with
 * the filing reporter's districts.
 */
export function isRajasthanStory(book: PlaceBook, district: string | null | undefined, tags: FileTags | null | undefined, text: StoryText, reporterDistricts?: readonly string[]): boolean {
  const place = book.district(district);
  return place ? place.rajasthan : !nationalWithoutPlace(tags, text, book, reporterDistricts);
}

export function parseBreaking(text: string, fileName: string, book: PlaceBook): BreakingStory {
  const tags = fileTags(fileName, book.codes);
  const hint = tags.district;
  const needsCheck: NeedsCheck[] = [];
  const flag = (c: NeedsCheck) => {
    if (!needsCheck.includes(c)) needsCheck.push(c);
  };

  const fileLines = text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map(clean).filter(Boolean);
  let lines = fileLines;
  /**
   * The text taken off on purpose, for the text-kept check below: the file-name line, separator rows, desk notes,
   * datelines, the "बर्थ-डे" label and the place words before the headline. Every other word must reach the story.
   */
  const removed: string[] = [];
  // Line 1 repeats the file name (Latin, underscores); a name typed with a stray Hindi letter still counts
  if (lines[0] && !DEVANAGARI.test(lines[0].replace(/^[ऀ-ॿ]\s*/u, "")) && /_/.test(lines[0]) && /btn|breaking|nat_|_rj_|_raj_/i.test(lines[0])) {
    removed.push(lines[0]);
    lines = lines.slice(1);
  }
  // Separator rows (----, ****) and stray keystrokes ("ब्") carry nothing; a one-letter word ("है", "ॐ") is text
  for (const l of lines) if (isSeparator(l)) removed.push(l);
  lines = lines.filter((l) => !isSeparator(l));
  // "FULL_1041_कोटा से खबर" (the TV control room's full-screen re-save, from 25 Nov 2026): "FULL_", the file number, then a
  // copy of a line below. The label goes; its words stay only when none of the next lines carries them (owner, 26 Nov 2026)
  const full = lines[0] ? FULL_LABEL.exec(lines[0]) : null;
  if (full) {
    const rest = full[1]!.trim();
    const key = placeMatchKey(rest);
    // A label with no text goes; one of a letter or two ("FULL_5_ए") is no copy of anything: its words stay
    const repeated = !key || ([...key].length >= FULL_COPY_MIN_LETTERS && lines.slice(1, 4).some((l) => placeMatchKey(l).includes(key)));
    removed.push(repeated ? lines[0]! : lines[0]!.slice(0, lines[0]!.length - rest.length));
    lines = repeated ? lines.slice(1) : [rest, ...lines.slice(1)];
  }

  const notes = lines.filter(isDeskNote);
  for (const l of notes) removed.push(l);
  lines = lines.filter((l) => !isDeskNote(l));
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
  // Up to three dateline / label lines before the headline ("जयपुर", "करौली से खबर", "बर्थ-डे"). A byline stops the
  // scan: it is the headline, and the place it names ("जोधपुर से राजीव गौड़ की रिपोर्ट") is read for the tags.
  for (let n = 0; n < 3 && lines.length > 1; n++) {
    if (SECTION_LABEL.test(lines[0]!)) {
      removed.push(lines[0]!);
      lines = lines.slice(1);
      continue;
    }
    const by = bylinePlace(book, lines[0]!, hint);
    if (by) {
      if (!where?.district && by.district) from = "place_line";
      where = { district: where?.district ?? by.district, town: where?.town ?? by.town };
      break;
    }
    const p = placeLine(book, lines[0]!, hint);
    if (!p || p === "byline") break;
    removed.push(lines[0]!);
    lines = lines.slice(1);
    if (!where?.district && p.district) from = "place_line";
    where = { district: where?.district ?? p.district, town: where?.town ?? p.town };
  }

  let headline = lines[0]!.replace(BULLET, "");
  const rawHeadline = headline;
  const tagged = hashtagPrefix(book, headline, hint);
  if (tagged) {
    if (tagged.conflict) flag("place_conflict");
    // The desk tagged the place itself: its district wins over a place line, the file code and the text. Its words
    // ("#Kota #डग:") become line 1's tags
    removed.push(headline.slice(0, headline.length - tagged.rest.length));
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
  // "टोंक: ...", "आकोला: ..." (a known place, or one unknown Hindi word, which stays as the town)
  const prefix = tagged ? null : headlinePrefix(book, headline, hint);
  if (prefix) {
    removed.push(headline.slice(0, headline.length - prefix.rest.length));
    headline = prefix.rest;
    if (!where?.district) {
      where = { district: prefix.place.district ?? where?.district ?? null, town: where?.town ?? prefix.place.town };
      from = "headline_prefix";
    } else if (!where.town && prefix.place.town && prefix.place.district?.name === where.district.name) {
      where.town = prefix.place.town;
    }
  }
  // A dateline town the places file doesn't know that is a misspelling of a known place the headline names ("नागौर के
  // कुमाचन से खबर" over "कुचामन पंचायत समिति…"): the headline's spelling is the town, so line 1 and the card never carry
  // the name twice, two ways (owner, 25 Nov 2026)
  if (where?.town && !book.lookup(where.town)) {
    const fixed = headlineSpelling(book, where.town, headline);
    if (fixed) where = { ...where, town: fixed };
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
    const code = book.district(hint);
    const all = [headline, ...points].join(" । ");
    const inText = placeInText(book, all, hint);
    // P9 (owner, 25 Nov 2026): another Rajasthan district the headline opens with ("बालोतरा शहर के…" in a BAR file), or that
    // the headline names as "X शहर", beats any reporter's file code: the desk's own words
    const lead = code?.rajasthan ? leadDistrict(book, headline) : null;
    if (lead && lead.name !== code?.name) {
      district = lead;
      from = "headline_lead";
    // P3 (owner, 25 Nov 2026): a Rajasthan file code never beats a place outside Rajasthan that the text names, nor the
    // national flash's own rule when the text names no Rajasthan place (NAT_FLASH_RAJ_JPR's Bhopal, Hyderabad, Nepal,
    // Delhi-NCR stories went out "#Jaipur:")
    } else if (code?.rajasthan && !(inText && !inText.national) && nationalWithoutPlace(tags, [headline, ...points], book)) {
      national = true;
    } else {
      district = code;
      from = "file_code";
      national = !!district && !district.rajasthan;
    }
  }
  // Everything below is INFERRED (b6 fix brief P0): stored for the queue and its filters, only ever offered. Points that list
  // three or more districts (P11: a ranking) give none: "सीकर ने 90 अंकों के साथ…" is one entry of the list
  if (!district) {
    const inText = placeInText(book, headline, hint) ?? (isListStory(book, points.slice(0, 2)) ? null : placeInText(book, points.slice(0, 2).join(" । "), hint));
    if (inText && !inText.national) {
      district = inText.district;
      from = "text";
    } else if (inText) {
      national = true;
    }
  }
  // National news with no place (NWS desk files; the national flash by rule b) is not missing a district. A flash
  // with a Rajasthan place keeps it (owner 17 Nov 2026, replacing 15 Nov's L2 "always national")
  if (!district && !national && nationalWithoutPlace(tags, [headline, ...points], book)) national = true;
  const leaderPost = LEADER_POST.test(headline);
  // A leader's post and state-wide news (secretariat, a state decision) have no district and need none; nor does a
  // flash (a reporter's flash often has no place, and the reporter's own district rule fills it)
  if (!district && !national && !leaderPost && !isNationalFlash(tags) && !STATEWIDE.test([headline, ...points].join(" "))) flag("no_district");

  if (!headline) flag("no_headline");
  if (!DEVANAGARI.test([headline, ...points].join(" "))) flag("no_hindi");

  // The town the desk wrote (dateline or headline prefix) is kept, with or without a district (owner, 17 Nov 2026: a word
  // of the file is never dropped; before, "मासलपुर" with no district went nowhere). no_district still asks the desk to look
  const town = where?.town && where.town !== district?.hi ? where.town : null;

  // Safety net (owner, 17 Nov 2026): every word and number of the file reaches the story, except the lines taken off
  // on purpose (file name, separators, desk notes, datelines, bylines) and the place words before the headline that
  // became its tags. Anything else missing means a rule changed the desk's text: the story says so before posting.
  // Counted, not looked up: a "20" dropped from one line is not hidden by a "20" in another, and no district name is
  // credited unless the desk's own dateline or prefix (in `removed`) carried it.
  if (lostWords(fileLines, removed, [headline, ...points]).length) flag("text_changed");
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
