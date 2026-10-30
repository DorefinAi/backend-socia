// Places for the breaking files. The Rajasthan districts, their file-name codes and their towns come from a
// data file (rajasthan-places.json, read by the worker; shape below), so the gazetteer grows without a code
// change. The places outside Rajasthan, which only decide the footer tag, are listed here.
// Matching goes through fold() (nukta, chandrabindu, joiners), so spelling variants of one name collapse.

import { fold } from "../fold";
import { Gazetteer, type GazetteerMatch } from "../gazetteer";
import { RAJASTHAN_DISTRICTS } from "../rajasthan";

/** rajasthan-places.json */
export interface PlacesData {
  version: number;
  districts: {
    /** English hashtag without the #: "SawaiMadhopur" */
    tag: string;
    /** Hindi spellings, NFC */
    hi: string[];
    /** File-name codes: "SWM" */
    codes: string[];
    towns: { hi: string; tag: string }[];
  }[];
}

export interface DistrictInfo {
  /** "Sawai Madhopur": stories.district and the queue filter */
  name: string;
  /** Line 1's hashtag without the #: "SawaiMadhopur" */
  tag: string;
  hi: string;
  rajasthan: boolean;
}

export interface Place {
  kind: "district" | "town" | "national";
  /** The canonical Hindi spelling */
  hi: string;
  /** Hindi hashtag text for a town (no #) */
  tag: string;
  /** Candidate districts, the usual one first; one entry for a district or a national place */
  districts: DistrictInfo[];
}

const tagOf = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "");
/** "SawaiMadhopur" → "Sawai Madhopur" (the existing district list's English name), else the tag itself */
const NAME_OF_TAG = new Map(RAJASTHAN_DISTRICTS.map((d) => [tagOf(d.name).toLowerCase(), d.name]));

/** Ambiguous town names: the district they usually mean when nothing else says */
const USUAL: Record<string, string> = { शाहपुरा: "Jaipur", बस्सी: "Jaipur", रायपुर: "Pali", गंगापुर: "Sawai Madhopur", राजगढ़: "Alwar", रामगढ़: "Alwar", विजयनगर: "Beawar", गोविंदगढ़: "Jaipur" };

/**
 * Town names that are also everyday words (आंधी = dust storm, रानी = queen, नगर = town): a place line or an
 * "X के Y" phrase may name them, a headline or point may not. Towns of two districts are kept out of free text too.
 */
const NOT_IN_TEXT = new Set(
  ["आंधी", "तूफान", "बारिश", "सांभर", "मंडी", "थाना", "नगर", "शिव", "रानी", "बाप", "महाजन", "भीम", "सम", "पाटन", "देई", "डग", "आऊ", "गढ़ी", "लाठी", "बगड़", "रायपुर", "बाली", "पहाड़ी", "वैर", "सेवर", "बाड़ी", "इटावा", "मनिया", "लवाण", "बसवा", "मानपुर", "कामां", "महला", "धोद", "करवर", "सीकरी", "रारह", "चिखली", "खाटू", "कुचेरा"].map(fold),
);

/** Outside Rajasthan: a place line here gets this English tag and the #FirstIndiaNews footer */
const NATIONAL: [string, string[]][] = [
  ["Delhi", ["दिल्ली", "नई दिल्ली", "दिल्ली-NCR", "दिल्ली एनसीआर"]],
  ["Lucknow", ["लखनऊ"]], ["Varanasi", ["वाराणसी"]], ["Mumbai", ["मुंबई"]], ["Kolkata", ["कोलकाता"]], ["Patna", ["पटना"]],
  ["Bhopal", ["भोपाल"]], ["Indore", ["इंदौर"]], ["Chandigarh", ["चंडीगढ़"]], ["Ahmedabad", ["अहमदाबाद"]], ["Gandhinagar", ["गांधीनगर"]],
  ["Noida", ["नोएडा"]], ["Gurugram", ["गुरुग्राम", "गुड़गांव"]], ["Agra", ["आगरा"]], ["Prayagraj", ["प्रयागराज"]], ["Ayodhya", ["अयोध्या"]],
  ["Hyderabad", ["हैदराबाद"]], ["Bengaluru", ["बेंगलुरु", "बेंगलुरू"]], ["Chennai", ["चेन्नई"]], ["Srinagar", ["श्रीनगर"]],
  ["Jammu", ["जम्मू"]], ["Dehradun", ["देहरादून"]], ["Shimla", ["शिमला"]], ["Ranchi", ["रांची"]], ["Mathura", ["मथुरा"]],
  ["Bihar", ["बिहार"]], ["UttarPradesh", ["उत्तर प्रदेश", "यूपी"]], ["MadhyaPradesh", ["मध्य प्रदेश", "मध्यप्रदेश"]], ["Punjab", ["पंजाब"]],
  ["Haryana", ["हरियाणा"]], ["Gujarat", ["गुजरात"]], ["Maharashtra", ["महाराष्ट्र"]], ["WestBengal", ["पश्चिम बंगाल"]], ["Karnataka", ["कर्नाटक"]],
  ["JammuKashmir", ["जम्मू-कश्मीर", "जम्मू कश्मीर"]], ["Uttarakhand", ["उत्तराखंड"]], ["HimachalPradesh", ["हिमाचल प्रदेश", "हिमाचल"]],
  ["Kerala", ["केरल"]], ["TamilNadu", ["तमिलनाडु"]], ["Assam", ["असम"]], ["Odisha", ["ओडिशा"]], ["Jharkhand", ["झारखंड"]],
  ["Chhattisgarh", ["छत्तीसगढ़"]], ["Telangana", ["तेलंगाना"]], ["AndhraPradesh", ["आंध्र प्रदेश"]],
  ["Pakistan", ["पाकिस्तान"]], ["China", ["चीन"]], ["Nepal", ["नेपाल"]], ["Bangladesh", ["बांग्लादेश"]], ["USA", ["अमेरिका"]],
  ["Russia", ["रूस"]], ["Ukraine", ["यूक्रेन"]], ["Israel", ["इजराइल", "इजरायल"]], ["Iran", ["ईरान"]], ["Afghanistan", ["अफगानिस्तान"]],
];
const NATIONAL_INFO: DistrictInfo[] = NATIONAL.map(([name, [hi]]) => ({ name, tag: name, hi: hi!, rajasthan: false }));

const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Checks a parsed rajasthan-places.json. A file that is not the right shape at all throws (the loader keeps its
 * last good copy). A bad entry inside it is skipped and reported through `problem`, so one typo costs one
 * district or town, not the whole gazetteer: a district with no tag, a repeated tag or no Hindi name; a code
 * another district already has; a town with no Hindi name or a tag that is not text.
 */
export function parsePlacesData(json: unknown, problem: (message: string) => void = () => undefined): PlacesData {
  const root = json as { version?: unknown; districts?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.districts)) throw new Error("rajasthan places: expected { version, districts: [...] }");
  const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
  const tags = new Set<string>();
  const codes = new Set<string>();
  const districts: PlacesData["districts"] = [];

  (root.districts as unknown[]).forEach((raw, i) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    const where = `districts[${i}]`;
    const tag = typeof d.tag === "string" ? d.tag.trim().replace(/^#/, "") : "";
    if (!/^[A-Za-z0-9]+$/.test(tag)) return problem(`${where}: tag must be an English hashtag without # (skipped)`);
    if (tags.has(tag.toLowerCase())) return problem(`${where}: tag ${tag} appears twice (skipped)`);
    const hi = texts(d.hi).map((s) => s.normalize("NFC")).filter((s) => DEVANAGARI.test(s));
    if (!hi.length) return problem(`${where} ${tag}: no Hindi name (skipped)`);
    tags.add(tag.toLowerCase());

    const own: string[] = [];
    for (const c of texts(d.codes).map((x) => x.trim().toUpperCase())) {
      if (!/^[A-Z]{2,4}$/.test(c)) problem(`${where} ${tag}: code "${c}" is not 2-4 letters (skipped)`);
      else if (codes.has(c)) problem(`${where} ${tag}: code ${c} already belongs to another district (skipped)`);
      else {
        codes.add(c);
        own.push(c);
      }
    }
    const towns: PlacesData["districts"][number]["towns"] = [];
    (Array.isArray(d.towns) ? d.towns : []).forEach((rawTown, j) => {
      const t = (rawTown ?? {}) as Record<string, unknown>;
      if (typeof t.hi !== "string" || !DEVANAGARI.test(t.hi)) return problem(`${where} ${tag}: towns[${j}] has no Hindi name (skipped)`);
      if (t.tag !== undefined && typeof t.tag !== "string") return problem(`${where} ${tag}: towns[${j}] tag is not text (skipped)`);
      const townTag = ((t.tag as string | undefined) || t.hi).normalize("NFC").replace(/^#/, "").trim();
      towns.push({ hi: t.hi.normalize("NFC"), tag: townTag });
    });
    districts.push({ tag, hi, codes: own, towns });
  });
  return { version: Number(root.version ?? 1), districts };
}

/** The places of one data file: lookups for the place line, a gazetteer for the text, the file-name codes */
export class PlaceBook {
  private readonly places = new Map<string, Place>();
  private readonly byName = new Map<string, DistrictInfo>();
  /** "JDR" → "Jodhpur" */
  readonly codes: Record<string, string> = {};
  private readonly gazetteer: Gazetteer<Place>;
  readonly districts: DistrictInfo[];

  constructor(data: PlacesData) {
    this.districts = data.districts.map((d) => ({ name: NAME_OF_TAG.get(d.tag.toLowerCase()) ?? d.tag, tag: d.tag, hi: d.hi[0] ?? d.tag, rajasthan: true }));
    for (const info of [...this.districts, ...NATIONAL_INFO]) this.byName.set(info.name, info);
    data.districts.forEach((d, i) => {
      const info = this.districts[i]!;
      for (const c of d.codes) this.codes[c] = info.name;
      for (const s of d.hi) this.put(s, { kind: "district", hi: info.hi, tag: info.tag, districts: [info] });
    });
    data.districts.forEach((d, i) => {
      for (const t of d.towns) this.put(t.hi, { kind: "town", hi: t.hi, tag: t.tag, districts: [this.districts[i]!] });
    });
    for (const [spelling, district] of Object.entries(USUAL)) {
      const p = this.places.get(fold(spelling));
      const usual = this.byName.get(district);
      if (p && usual && p.districts.includes(usual)) p.districts = [usual, ...p.districts.filter((x) => x !== usual)];
    }
    for (const [i, [, spellings]] of NATIONAL.entries()) {
      const info = NATIONAL_INFO[i]!;
      for (const s of spellings) this.put(s, { kind: "national", hi: spellings[0]!, tag: info.tag, districts: [info] });
    }
    this.gazetteer = new Gazetteer<Place>(
      [...this.places.entries()]
        .filter(([key, place]) => !NOT_IN_TEXT.has(key) && !(place.kind === "town" && place.districts.length > 1))
        // A district outranks a town of the same length; national places last
        .map(([key, place]) => ({ id: key, name: key, aliases: [], priority: place.kind === "district" ? 2 : place.kind === "town" ? 1 : 0, data: place })),
    );
  }

  private put(spelling: string, place: Place): void {
    const key = fold(spelling);
    if (!key) return;
    const prev = this.places.get(key);
    if (!prev) return void this.places.set(key, place);
    // A district name always wins over a town of the same spelling; towns of two districts merge
    if (prev.kind !== "town") return;
    if (place.kind !== "town") return void this.places.set(key, place);
    for (const d of place.districts) if (!prev.districts.includes(d)) prev.districts.push(d);
  }

  /** The place a whole phrase names ("रावतभाटा", "मारवाड़ जंक्शन"), or null */
  lookup(phrase: string): Place | null {
    const key = fold(phrase);
    return key ? (this.places.get(key) ?? null) : null;
  }

  /** Places named anywhere in the text, in reading order */
  find(text: string): GazetteerMatch<Place>[] {
    return this.gazetteer.find(text).sort((a, b) => a.start - b.start);
  }

  /** A district (Rajasthan) or national place by its English name, as stored in stories.district */
  district(name: string | null | undefined): DistrictInfo | null {
    return name ? (this.byName.get(name) ?? null) : null;
  }

  /** A town's Hindi hashtag text from the data, when the town is known */
  townTag(town: string): string | null {
    const p = this.lookup(town);
    return p?.kind === "town" ? p.tag : null;
  }
}
