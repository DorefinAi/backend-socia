// Story search without AI: the desk types Hindi (जयपुर, हादसा), Roman Hindi (jaipur, jaypur, hadsa, baadh) or
// English (accident, flood, police) and finds the same stories. Three deterministic ways a query word can match:
//   text        its folded form is in the story's folded text (fold.ts);
//   phonetic    its phonetic key is in the story's phonetic key: Hindi written in plain Latin (story-name.ts'
//               transliterator) and squeezed so common Hinglish spellings collide (jaypur = jaipur, haadsa = हादसा);
//   translated  an English newsroom word in GLOSSARY, a Rajasthan district by any of its names, or a Roman
//               spelling of a glossary word (hadsa → हादसा) brings in its Hindi / English forms.
// The API stores the folded text and the key of every story (story_search), padded with spaces, and matches a
// form inside a word, at a word's start or as a whole word (formMatch), so पुल (bridge) never matches पुलिस.

import { fold } from "./fold";
import { RAJASTHAN_DISTRICTS } from "./rajasthan";
import { SEARCH_GLOSSARY } from "./search-glossary";
import { transliterateWord } from "./story-name";

/** Query words past this are ignored */
export const SEARCH_MAX_WORDS = 8;
/** Shorter query words (in characters) are ignored */
export const SEARCH_MIN_WORD_CHARS = 2;
/** Glossary and district lookups by phonetic key need a key this long (shorter ones collide too much) */
export const SEARCH_PREFIX_MIN_CHARS = 3;

const DEVANAGARI = /[ऀ-ॿ]/;

/** One Latin word squeezed so Hinglish spellings collide: jaypur/jaipur, haadsa/hadsa, baadh, phool/fool */
function squeeze(latin: string): string {
  let w = latin.toLowerCase().replace(/[^a-z0-9]/g, "");
  w = w.replace(/ph/g, "f").replace(/q/g, "k").replace(/w/g, "v").replace(/z/g, "j");
  w = w.replace(/ee/g, "i").replace(/oo/g, "u");
  // Any doubled letter once: aa, ii, uu, ll, tt, chh → a, i, u, l, t, ch
  w = w.replace(/([a-z])\1+/g, "$1");
  // A y after a vowel and before a consonant (or at the end) is said as i: jaypur → jaipur, jay → jai
  w = w.replace(/([aeiou])y(?=[^aeiou]|$)/g, "$1i");
  // A word-final a (schwa or aa): hadsa → hads, so हादसे (hadse) still starts with it
  if (w.length > 2 && w.endsWith("a")) w = w.slice(0, -1);
  return w;
}

/**
 * The phonetic key of a text: folded, Devanagari words written in plain Latin, then each word squeezed.
 * Words are joined by single spaces; "" for a text with no letters or digits.
 */
export function phoneticKey(text: string): string {
  return fold(text)
    .split(" ")
    .map((w) => squeeze(DEVANAGARI.test(w) ? transliterateWord(w) : w))
    .filter(Boolean)
    .join(" ");
}

// ---- Glossary -------------------------------------------------------------------------------------------------

/**
 * Our own first list, kept only for English words SEARCH_GLOSSARY (search-glossary.ts, the vetted list) does not
 * have. Avoid forms that are also a common Hindi word (कर "tax" is also "do").
 */
const LOCAL_GLOSSARY: Readonly<Record<string, readonly string[]>> = {
  // Accidents, weather, disaster
  accident: ["दुर्घटना", "हादसा", "एक्सीडेंट"],
  crash: ["दुर्घटना", "हादसा"],
  collision: ["भिड़ंत", "टक्कर"],
  flood: ["बाढ़"],
  rain: ["बारिश", "वर्षा", "बरसात"],
  storm: ["तूफान", "आंधी"],
  drought: ["सूखा", "अकाल"],
  heat: ["गर्मी", "लू"],
  heatwave: ["लू", "हीटवेव"],
  cold: ["ठंड", "सर्दी"],
  fog: ["कोहरा"],
  lightning: ["आकाशीय बिजली", "बिजली गिरने"],
  electricity: ["बिजली"],
  power: ["बिजली"],
  current: ["करंट"],
  electrocution: ["करंट"],
  drowning: ["डूब"],
  drown: ["डूब"],
  fire: ["आग", "अग्निकांड"],
  blaze: ["आग", "अग्निकांड"],
  blast: ["धमाका", "विस्फोट"],
  explosion: ["धमाका", "विस्फोट"],
  collapse: ["ढह", "धराशायी"],
  stampede: ["भगदड़"],
  crowd: ["भीड़"],
  rescue: ["रेस्क्यू", "बचाव"],
  ambulance: ["एंबुलेंस", "एम्बुलेंस"],
  compensation: ["मुआवजा"],
  alert: ["अलर्ट", "चेतावनी"],
  weather: ["मौसम"],
  temperature: ["तापमान", "पारा"],
  // Water, land, environment
  water: ["पानी", "जल"],
  dam: ["बांध"],
  river: ["नदी"],
  lake: ["झील", "तालाब"],
  pond: ["तालाब"],
  well: ["कुआं", "कुएं"],
  pipeline: ["पाइपलाइन"],
  land: ["जमीन", "भूमि"],
  house: ["मकान", "घर"],
  forest: ["जंगल", "वन"],
  pollution: ["प्रदूषण"],
  garbage: ["कचरा"],
  cleanliness: ["सफाई", "स्वच्छता"],
  mining: ["खनन"],
  illegal: ["अवैध"],
  encroachment: ["अतिक्रमण"],
  bulldozer: ["बुलडोजर"],
  solar: ["सोलर", "सौर"],
  // Crime and police
  police: ["पुलिस"],
  murder: ["हत्या", "मर्डर", "कत्ल"],
  kill: ["हत्या"],
  killed: ["हत्या", "मौत"],
  death: ["मौत", "मृत्यु"],
  died: ["मौत", "मृत्यु", "मृत"],
  die: ["मौत", "मृत्यु"],
  dead: ["मौत", "मृत", "शव"],
  body: ["शव", "लाश"],
  corpse: ["शव", "लाश"],
  injured: ["घायल"],
  injury: ["घायल", "चोट"],
  arrest: ["गिरफ्तार", "गिरफ्तारी"],
  custody: ["हिरासत"],
  accused: ["आरोपी"],
  criminal: ["अपराधी", "बदमाश"],
  crime: ["अपराध"],
  victim: ["पीड़ित"],
  complaint: ["शिकायत"],
  investigation: ["जांच"],
  probe: ["जांच"],
  theft: ["चोरी"],
  thief: ["चोर"],
  stolen: ["चोरी"],
  robbery: ["लूट", "डकैती"],
  loot: ["लूट"],
  fraud: ["धोखाधड़ी", "ठगी", "फर्जीवाड़ा"],
  scam: ["घोटाला", "ठगी"],
  bribe: ["रिश्वत", "घूस"],
  corruption: ["भ्रष्टाचार"],
  rape: ["दुष्कर्म", "बलात्कार"],
  molestation: ["छेड़छाड़"],
  kidnap: ["अपहरण"],
  kidnapping: ["अपहरण"],
  abduction: ["अपहरण"],
  suicide: ["आत्महत्या", "खुदकुशी"],
  missing: ["लापता", "गुमशुदा"],
  dowry: ["दहेज"],
  drug: ["नशा", "मादक पदार्थ", "ड्रग्स"],
  smuggling: ["तस्करी"],
  smuggler: ["तस्कर"],
  liquor: ["शराब"],
  alcohol: ["शराब"],
  firing: ["फायरिंग", "गोली"],
  gun: ["हथियार", "बंदूक", "पिस्टल"],
  weapon: ["हथियार"],
  shot: ["गोली"],
  attack: ["हमला"],
  fight: ["झगड़ा", "मारपीट"],
  clash: ["झड़प", "विवाद", "मारपीट"],
  dispute: ["विवाद"],
  raid: ["छापा", "छापेमारी", "रेड"],
  seized: ["जब्त"],
  seizure: ["जब्त"],
  fake: ["फर्जी", "नकली"],
  cheating: ["नकल"],
  leak: ["लीक"],
  cyber: ["साइबर"],
  fir: ["एफआईआर", "मुकदमा"],
  case: ["मामला", "प्रकरण", "केस"],
  // Courts
  court: ["कोर्ट", "न्यायालय", "अदालत"],
  judge: ["जज", "न्यायाधीश"],
  verdict: ["फैसला", "निर्णय"],
  sentence: ["सजा"],
  jail: ["जेल"],
  bail: ["जमानत"],
  // Politics and government
  election: ["चुनाव", "इलेक्शन"],
  vote: ["मतदान", "वोट"],
  voting: ["मतदान", "वोटिंग"],
  voter: ["मतदाता"],
  candidate: ["प्रत्याशी", "उम्मीदवार"],
  result: ["परिणाम", "नतीजा", "रिजल्ट"],
  minister: ["मंत्री"],
  cm: ["मुख्यमंत्री", "सीएम"],
  pm: ["प्रधानमंत्री", "पीएम"],
  mla: ["विधायक"],
  mp: ["सांसद"],
  governor: ["राज्यपाल"],
  collector: ["कलेक्टर", "जिला कलेक्टर"],
  sp: ["एसपी", "पुलिस अधीक्षक"],
  officer: ["अधिकारी"],
  government: ["सरकार"],
  party: ["पार्टी"],
  congress: ["कांग्रेस"],
  bjp: ["भाजपा", "बीजेपी"],
  assembly: ["विधानसभा"],
  parliament: ["संसद"],
  budget: ["बजट"],
  scheme: ["योजना"],
  meeting: ["बैठक"],
  rally: ["रैली"],
  protest: ["प्रदर्शन", "धरना"],
  strike: ["हड़ताल"],
  demand: ["मांग"],
  memorandum: ["ज्ञापन"],
  inauguration: ["लोकार्पण", "उद्घाटन"],
  development: ["विकास"],
  project: ["परियोजना", "प्रोजेक्ट"],
  corporation: ["नगर निगम", "निगम"],
  municipality: ["नगर परिषद", "नगर पालिका", "नगरपालिका"],
  panchayat: ["पंचायत"],
  sarpanch: ["सरपंच"],
  district: ["जिला", "जिले"],
  state: ["राज्य", "प्रदेश"],
  rajasthan: ["राजस्थान"],
  india: ["भारत"],
  pakistan: ["पाकिस्तान"],
  // Health and education
  hospital: ["अस्पताल", "हॉस्पिटल", "चिकित्सालय"],
  doctor: ["डॉक्टर", "चिकित्सक"],
  patient: ["मरीज"],
  health: ["स्वास्थ्य"],
  disease: ["बीमारी", "रोग"],
  dengue: ["डेंगू"],
  treatment: ["इलाज", "उपचार"],
  medicine: ["दवा", "दवाई"],
  postmortem: ["पोस्टमार्टम"],
  school: ["स्कूल", "विद्यालय"],
  college: ["कॉलेज", "महाविद्यालय"],
  university: ["विश्वविद्यालय", "यूनिवर्सिटी"],
  student: ["छात्र", "विद्यार्थी"],
  teacher: ["शिक्षक", "अध्यापक"],
  exam: ["परीक्षा"],
  education: ["शिक्षा"],
  // Economy, farming, work
  farmer: ["किसान", "कृषक"],
  crop: ["फसल"],
  agriculture: ["कृषि", "खेती"],
  market: ["बाजार", "मंडी"],
  price: ["दाम", "कीमत", "भाव"],
  inflation: ["महंगाई"],
  petrol: ["पेट्रोल"],
  diesel: ["डीजल"],
  gas: ["गैस"],
  cylinder: ["सिलेंडर"],
  bank: ["बैंक"],
  loan: ["ऋण", "लोन"],
  gold: ["सोना", "सोने"],
  silver: ["चांदी"],
  ration: ["राशन"],
  job: ["नौकरी", "रोजगार"],
  recruitment: ["भर्ती"],
  salary: ["वेतन"],
  pension: ["पेंशन"],
  // Transport
  road: ["सड़क", "मार्ग"],
  highway: ["हाईवे", "राजमार्ग"],
  bridge: ["पुल", "पुलिया"],
  train: ["ट्रेन", "रेल"],
  railway: ["रेलवे", "रेल"],
  bus: ["बस"],
  truck: ["ट्रक"],
  car: ["कार"],
  bike: ["बाइक", "मोटरसाइकिल"],
  tractor: ["ट्रैक्टर"],
  traffic: ["यातायात", "ट्रैफिक", "जाम"],
  // People and places
  village: ["गांव", "ग्राम"],
  city: ["शहर"],
  woman: ["महिला"],
  child: ["बच्चा", "बच्चे", "बालक", "मासूम"],
  girl: ["बालिका", "लड़की", "छात्रा"],
  boy: ["बालक", "लड़का"],
  youth: ["युवक", "युवा"],
  family: ["परिवार"],
  husband: ["पति"],
  wife: ["पत्नी"],
  army: ["सेना", "फौज"],
  soldier: ["जवान", "सैनिक"],
  martyr: ["शहीद"],
  border: ["सीमा", "बॉर्डर"],
  drone: ["ड्रोन"],
  terrorist: ["आतंकी", "आतंकवादी"],
  // Animals
  leopard: ["तेंदुआ", "पैंथर"],
  panther: ["पैंथर", "तेंदुआ"],
  tiger: ["बाघ", "टाइगर"],
  cow: ["गाय", "गौवंश"],
  cattle: ["मवेशी", "पशु"],
  animal: ["पशु", "जानवर"],
  camel: ["ऊंट"],
  snake: ["सांप"],
  dog: ["कुत्ता", "श्वान"],
  wildlife: ["वन्यजीव"],
  // Faith, festivals, tourism
  temple: ["मंदिर"],
  mosque: ["मस्जिद"],
  festival: ["त्योहार", "पर्व", "उत्सव"],
  fair: ["मेला"],
  wedding: ["शादी", "विवाह"],
  marriage: ["शादी", "विवाह"],
  pilgrim: ["श्रद्धालु"],
  holi: ["होली"],
  diwali: ["दिवाली", "दीपावली"],
  eid: ["ईद"],
  tourism: ["पर्यटन"],
  tourist: ["पर्यटक"],
  fort: ["किला", "दुर्ग"],
  palace: ["महल"],
  funeral: ["अंतिम संस्कार"],
  tribute: ["श्रद्धांजलि"],
  cricket: ["क्रिकेट"],
  sports: ["खेल"],
  mobile: ["मोबाइल", "फोन"],
  phone: ["फोन", "मोबाइल"],
};

/**
 * English word or phrase (lower case) → Hindi forms: every `en` of SEARCH_GLOSSARY, plus LOCAL_GLOSSARY's words
 * it lacks. Plurals and past forms are found by dropping s / es / ies → y / ed. A form may be several words.
 */
export const GLOSSARY: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, readonly string[]> = {};
  for (const e of SEARCH_GLOSSARY) for (const en of e.en) out[en.toLowerCase()] = e.hi;
  for (const [en, hi] of Object.entries(LOCAL_GLOSSARY)) if (!out[en]) out[en] = hi;
  return out;
})();

/** English plural / past forms to a glossary key: accidents → accident, injuries → injury, arrested → arrest */
function glossaryKey(word: string): string | null {
  const w = word.toLowerCase();
  if (GLOSSARY[w]) return w;
  const tries = [w.endsWith("ies") ? `${w.slice(0, -3)}y` : null, w.endsWith("es") ? w.slice(0, -2) : null, w.endsWith("s") ? w.slice(0, -1) : null, w.endsWith("ed") ? w.slice(0, -2) : null];
  return tries.find((t): t is string => !!t && !!GLOSSARY[t]) ?? null;
}

/**
 * A typed Roman word's phonetic key → Hindi forms: SEARCH_GLOSSARY's Roman spellings (thana → थाना, थाने), and
 * the key of every glossary Hindi form itself (hadsa → हादसा, baadh → बाढ़). Keys shorter than
 * SEARCH_PREFIX_MIN_CHARS are left out (too many collisions). Built once.
 */
let hindiByKey: Map<string, string[]> | null = null;
function hindiForms(key: string): string[] {
  if (!hindiByKey) {
    const map = new Map<string, string[]>();
    const add = (k: string, forms: readonly string[]) => {
      if (k.length < SEARCH_PREFIX_MIN_CHARS) return;
      const list = map.get(k) ?? [];
      for (const f of forms) if (!list.includes(f)) list.push(f);
      map.set(k, list);
    };
    for (const e of SEARCH_GLOSSARY) for (const r of e.roman) add(phoneticKey(r), e.hi);
    for (const forms of Object.values(GLOSSARY)) for (const f of forms) add(phoneticKey(f), [f]);
    hindiByKey = map;
  }
  return hindiByKey.get(key) ?? [];
}

/** A district named by the word in any script or spelling: jaipur, jaypur, JAIPUR, जयपुर; banswara, बांसवाडा */
const DISTRICT_NAMES = RAJASTHAN_DISTRICTS.map((d) => ({
  district: d,
  names: [d.name, d.hi, ...d.aliases].map((n) => ({ folded: fold(n), key: phoneticKey(n) })),
}));
function districtNamed(word: string, key: string) {
  return DISTRICT_NAMES.find(({ names }) =>
    names.some((n) => n.folded === word || (key.length >= SEARCH_PREFIX_MIN_CHARS && n.key === key)),
  )?.district;
}

/**
 * The other ending of a Hindi noun / adjective (हादसा ↔ हादसे, थाना ↔ थाने): the same word, folded. Only ा ↔ े,
 * and only when the rest keeps INFLECT_MIN_CHARS code points: a blind stem would be noise (वर्षा "rain" → वर्ष
 * "year", in nearly every story as वर्षीय), and ों / ी endings change the meaning too often (वर्षों, लड़की).
 */
const INFLECT_MIN_CHARS = 3;
const OTHER_ENDING: Record<string, string> = { "ा": "े", "े": "ा" };
function inflectionOf(form: string): string | null {
  const cps = [...form];
  const other = OTHER_ENDING[cps.at(-1) ?? ""];
  if (!other || form.includes(" ") || !DEVANAGARI.test(form) || cps.length - 1 < INFLECT_MIN_CHARS) return null;
  return cps.slice(0, -1).join("") + other;
}

/**
 * English and Roman Hindi filler: dropped from a query (every remaining word must match). Latin only: a typed
 * Devanagari word is always kept.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  "in", "at", "of", "on", "the", "for", "to", "and", "a", "an", "is", "ka", "ki", "ke", "me", "mein", "se", "ko", "par", "aur", "hai",
]);

/** Longest glossary phrase looked up across query words ("paper leak", "police station", "bhari barish") */
const PHRASE_MAX_WORDS = 4;

// ---- Query expansion ----------------------------------------------------------------------------------------------

export interface SearchWord {
  /** The word (or glossary phrase: "paper leak") as typed, folded */
  raw: string;
  /** The typed word's own literal form (= texts[0] = raw), matched by the typed-word rules (formMatch) */
  typed: string;
  /** The typed Hindi word's other ending (हादसा → हादसे), folded; a literal match like raw itself; [] when none */
  variants: string[];
  /** Folded literal forms: texts[0] is the typed word itself, the rest come from the glossary or a district (and their other endings) */
  texts: string[];
  /** Phonetic keys: keys[0] is the typed word's own key, the rest are the keys of the other texts (deduplicated) */
  keys: string[];
  /** The forms beyond the typed word as written for people (not folded): "बाढ़", "Jaipur"; [] when none */
  expanded: string[];
}

/** The Hindi forms a Latin word or phrase stands for: English (glossary, plurals) or a Roman spelling */
function latinForms(raw: string, key: string): string[] {
  const g = glossaryKey(raw);
  return [...(g ? GLOSSARY[g]! : []), ...(key.length >= SEARCH_PREFIX_MIN_CHARS ? hindiForms(key) : [])];
}

function searchWord(raw: string): SearchWord | null {
  const key = phoneticKey(raw);
  if (!key) return null;
  const latin = !DEVANAGARI.test(raw);
  // English or a Roman spelling of a glossary word (hadsa, baadh, pulis, thana); a typed Hindi word is taken as it is
  const shown = latin ? latinForms(raw, key) : [];
  const d = raw.includes(" ") ? null : districtNamed(raw, key);
  if (d) shown.push(d.name, d.hi, ...d.aliases);

  const texts = [raw];
  const expanded: string[] = [];
  for (const form of shown) {
    const f = fold(form);
    if (!f || texts.includes(f)) continue;
    texts.push(f);
    expanded.push(form.normalize("NFC"));
  }
  const keys = [...new Set([key, ...texts.slice(1).map(phoneticKey).filter(Boolean)])];
  for (const t of texts.slice(1)) {
    const other = inflectionOf(t);
    if (other && !texts.includes(other)) texts.push(other);
  }
  const own = inflectionOf(raw);
  return { raw, typed: raw, variants: own ? [own] : [], texts, keys, expanded };
}

/**
 * A query's words (at most SEARCH_MAX_WORDS, each of SEARCH_MIN_WORD_CHARS characters or more), each with
 * its literal forms and phonetic keys. Consecutive Latin words that make a glossary phrase ("paper leak") are one
 * word. Every word must match a story (AND); any of a word's forms will do (OR).
 */
export function expandQuery(q: string): { words: SearchWord[] } {
  const raws = [...new Set(fold(q).split(" ").filter((w) => [...w].length >= SEARCH_MIN_WORD_CHARS))].slice(0, SEARCH_MAX_WORDS);
  const words: SearchWord[] = [];
  // Filler words go ("accident in jaipur" = accident jaipur), after phrases are found ("station in charge"),
  // unless the query is nothing but filler ("of" still searches)
  const keep = (w: SearchWord) => !FILLER_WORDS.has(w.raw);
  for (let i = 0; i < raws.length; ) {
    let taken = 1;
    for (let n = Math.min(PHRASE_MAX_WORDS, raws.length - i); n >= 2; n--) {
      const part = raws.slice(i, i + n);
      const phrase = part.join(" ");
      if (part.every((w) => !DEVANAGARI.test(w)) && latinForms(phrase, phoneticKey(phrase)).length) {
        taken = n;
        break;
      }
    }
    const w = searchWord(raws.slice(i, i + taken).join(" "));
    if (w) words.push(w);
    i += taken;
  }
  return { words: words.some(keep) ? words.filter(keep) : words };
}

// ---- Matching ---------------------------------------------------------------------------------------------------

/** A stored search column: the folded text or key in single spaces (" jaipur hads "), "" for none */
export function searchField(foldedOrKey: string): string {
  // fold() already turns NUL into a space; never let one reach a text column (Postgres refuses \u0000)
  const clean = foldedOrKey.replace(/\u0000/g, "");
  return clean ? ` ${clean} ` : "";
}

/**
 * How a form must sit in a searchField column:
 *   substring  anywhere, even inside a word: what was typed, when it has SUBSTRING_MIN_CHARS characters or more;
 *   start      at a word's start: shorter typed words, and expanded forms (so हादसा's stem still meets हादसे);
 *   word       a whole word: expanded forms of WHOLE_WORD_MAX_CHARS characters or fewer (पुल is not पुलिस,
 *              कार is not सरकार, cm is not cmho).
 */
export type FormMatch = "substring" | "start" | "word";
export const SUBSTRING_MIN_CHARS = 4;
export const WHOLE_WORD_MAX_CHARS = 3;

/** typed: the user's own word (or its key); otherwise a glossary / district form (or its key) */
export function formMatch(form: string, typed: boolean): FormMatch {
  const n = [...form].length;
  if (typed) return n >= SUBSTRING_MIN_CHARS ? "substring" : "start";
  return n <= WHOLE_WORD_MAX_CHARS ? "word" : "start";
}

/** The LIKE pattern for a form against a searchField column; % _ and \ in the form are escaped */
export function searchPattern(form: string, typed: boolean): string {
  const esc = form.replace(/[\\%_]/g, (c) => "\\" + c);
  const how = formMatch(form, typed);
  return how === "substring" ? `%${esc}%` : how === "start" ? `% ${esc}%` : `% ${esc} %`;
}

/** The LIKE pattern for the form as a whole word (or whole words), whatever its length: "% पुल %" */
export function wholeWordPattern(form: string): string {
  return `% ${form.replace(/[\\%_]/g, (c) => "\\" + c)} %`;
}

/** Whether a searchField value holds the form as formMatch says (the JS twin of searchPattern) */
export function fieldMatches(field: string, form: string, typed: boolean): boolean {
  const how = formMatch(form, typed);
  return how === "substring" ? field.includes(form) : field.includes(how === "start" ? ` ${form}` : ` ${form} `);
}

/** Snippet length in characters (ellipses not counted) and how much of it comes before the match */
export const SNIPPET_CHARS = 140;
/** The snippet looks for a match in this much of the body at most (a huge body costs no more CPU than this) */
export const SNIPPET_SCAN_CHARS = 20_000;
const SNIPPET_LEAD = 40;

/**
 * About SNIPPET_CHARS of the body around the first word any query word matches (by a text or a key, by the
 * same rules as the search), with "…" where it was cut; the body's start when no word matches; null for an
 * empty body. Whitespace is collapsed.
 */
export function searchSnippet(body: string | null | undefined, words: readonly SearchWord[]): string | null {
  const text = (body ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  // Every form whole: a two-word form or key ("सडक हादसा", "sadak hads") must meet two body words in a row
  const forms = words.flatMap((w) => [
    ...w.texts.map((t, i) => ({ form: t, typed: i === 0, key: false })),
    ...w.variants.map((v) => ({ form: v, typed: false, key: false })),
    ...w.keys.map((k, i) => ({ form: k, typed: i === 0, key: true })),
  ]).map((x) => ({ ...x, n: x.form.split(" ").length }));
  // Body words with their folded form and key, each distinct word worked out once
  const seen = new Map<string, { f: string; k: string }>();
  const tokens = [...text.slice(0, SNIPPET_SCAN_CHARS).matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((m) => {
    let fk = seen.get(m[0]);
    if (!fk) {
      fk = { f: fold(m[0]), k: phoneticKey(m[0]) };
      seen.set(m[0], fk);
    }
    return { at: m.index, ...fk };
  });
  // A form matched starting at body word i, by the same rules as the search (formMatch)
  const startsHere = (i: number, x: (typeof forms)[number]) => {
    const window = tokens.slice(i, i + x.n).map((t) => (x.key ? t.k : t.f)).filter(Boolean).join(" ");
    const how = formMatch(x.form, x.typed);
    return how === "word" ? window === x.form : how === "start" ? window.startsWith(x.form) : window.includes(x.form);
  };
  let at = -1;
  for (let i = 0; i < tokens.length && at < 0; i++) if (forms.some((x) => startsHere(i, x))) at = tokens[i]!.at;
  if (text.length <= SNIPPET_CHARS) return text;
  let start = at <= SNIPPET_LEAD ? 0 : at - SNIPPET_LEAD;
  // Start and end on a word boundary
  if (start > 0) {
    const space = text.indexOf(" ", start);
    start = space >= 0 && space < at ? space + 1 : start;
  }
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + SNIPPET_CHARS / 2) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
