// Step 5: the post around a clip's headline (README §5): place, channel label, hashtags and @handles, each on (emit)
// or off (suggest). The desk adds the brand tag and #FINVideo itself (from the channel label and region).
//
// A port of directory/eval.py's predict(), with the mix it measured best (27 Nov 2026, built on posts up to 13 Nov,
// tested on the 55 posts of 21 and 27 Nov):
//   tags     from the video directory (directory/tags.json: the tags the desk used on #FINVideo posts, keywords copied
//            from the breaking desk), campaign patterns inside their own dates: topic tags right 48 % (vs 18 % with the
//            breaking desk's person and party tags added)
//   handles  from the breaking desk's whole directory (apps/worker/config): collectors found 92 %, police 62 %,
//            people / parties / offices 37 %
// Rules (README §5): the place tag and the district's police handle on a crime story are on; everything else is
// offered off. Reporter handles come only from the file's own name, never from the title. A clip read from the screen
// adds the model's place when the title names none, and its topic hashtags, offered off.
//
// A bad directory file never takes the desk down: a pattern that does not compile is skipped, a file that cannot be
// read keeps the last good directory (or none at first: then nothing is composed), and the problems are reported.

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEVA = `${String.fromCharCode(0x900)}-${String.fromCharCode(0x97f)}`;
const NUKTA = new RegExp(String.fromCharCode(0x93c), "g");
const HAS_DEVA = new RegExp(`[${DEVA}]`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** As the directory compares: the nukta left out, so "पड़ा" and "पडा" match (titles, terms and patterns alike) */
const plain = (s: string) => s.normalize("NFC").replace(NUKTA, "");

/** A word list as one matcher: Devanagari terms never inside a longer Devanagari word, Latin terms as whole words in any case */
export class XvTerms {
  private readonly deva: RegExp | null;
  private readonly latin: RegExp | null;

  constructor(terms: readonly unknown[]) {
    const clean = [...new Set(terms.filter((t): t is string => typeof t === "string").map((t) => plain(t).trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
    const d = clean.filter((t) => HAS_DEVA.test(t));
    const l = clean.filter((t) => !HAS_DEVA.test(t));
    this.deva = d.length ? new RegExp(`(?<![${DEVA}])(?:${d.map(escapeRe).join("|")})(?![${DEVA}])`, "u") : null;
    this.latin = l.length ? new RegExp(`(?<![A-Za-z0-9])(?:${l.map(escapeRe).join("|")})(?![A-Za-z0-9])`, "iu") : null;
  }

  get empty(): boolean {
    return !this.deva && !this.latin;
  }

  /** `text` already plain (see `plain`) */
  test(text: string): boolean {
    return !!(this.deva?.test(text) || this.latin?.test(text));
  }
}

/** A crime story: the district's police handle goes on (eval.py's list; stems such as "गिरफ्त" match on purpose) */
const CRIME = /हत्या|मर्डर|चोरी|लूट|गिरफ्तार|गिरफ्त|हादसा|दुर्घटना|मौत|शव|अपहरण|ठगी|फायरिंग|तस्कर|नशा|डकैती|बदमाश|आरोपी|वारदात|दुष्कर्म|एसीबी|ACB|कार्रवाई|पुलिस|थाना|जब्त|फरार|मारपीट|Accident|Crime|Police/i;
/** A story for the district's collector (offered), as whole words: "प्रधानमंत्री" and "ADM" are not these */
const DM_WORDS = new XvTerms(["कलेक्टर", "जिला प्रशासन", "प्रधान", "जिला प्रमुख", "निर्विरोध", "मतदान", "निर्वाचन", "Collector", "DM"]);

const IDENTIFIER = "#FINVideo";
const BRANDS = ["#RajasthanWithFirstIndia", "#FirstIndiaNews"];
const STATE_TAG = "#RajasthanNews";
/** eval.py offers #RajasthanNews while the desk uses it on at least this share of its recent posts */
const STATE_TAG_SHARE = 0.5;

interface Place {
  tag: string;
  terms: XvTerms;
}
interface TagRule {
  tag: string;
  kind: string;
  terms: XvTerms;
  /** Campaign patterns, each counting only inside its own dates */
  patterns: { re: RegExp; start: string | null; end: string | null }[];
}
interface HandleRule {
  handle: string;
  kind: string;
  district: string | null;
  terms: XvTerms;
}

/** The directory the composer reads */
export interface XvDirectory {
  places: Place[];
  otherStates: XvTerms;
  /** "#<City>" or "#<City>News": the place tag's form the desk uses now */
  placeForm: string;
  /** #RajasthanNews is offered while the desk still uses it this often (format.json) */
  offerStateTag: boolean;
  tags: TagRule[];
  handles: HandleRule[];
  /** Reporter handles, matched on the file's own name */
  reporters: HandleRule[];
  /** What was skipped while loading (a pattern that does not compile, an entry without a tag or handle) */
  problems: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function readJson(path: string): Json {
  try {
    return obj(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new Error(`directory file ${path}: ${(err as Error).message}`);
  }
}

/** Where the directory's files are: the video directory (this app) and the breaking desk's (apps/worker/config) */
export const XV_DIRECTORY_FILES = {
  videoDir: fileURLToPath(new URL("../../directory/", import.meta.url)),
  sharedDir: fileURLToPath(new URL("../../../worker/config/", import.meta.url)),
};
const VIDEO_FILES = ["format.json", "tags.json"];
const SHARED_FILES = ["rajasthan-places.json", "subject-handles.json", "party-handles.json", "district-handles.json", "reporter-handles.json"];

/** An empty directory: nothing is composed (used when the files cannot be read at all) */
export const XV_EMPTY_DIRECTORY: XvDirectory = { places: [], otherStates: new XvTerms([]), placeForm: "#<City>", offerStateTag: false, tags: [], handles: [], reporters: [], problems: [] };

/** Loads the directory; throws only when a file cannot be read or parsed (entries it cannot use are skipped and listed) */
export function xvLoadDirectory(videoDir = XV_DIRECTORY_FILES.videoDir, sharedDir = XV_DIRECTORY_FILES.sharedDir): XvDirectory {
  const problems: string[] = [];
  const format = readJson(`${videoDir}format.json`);
  const forms = Object.entries(obj(format.place_tag_form_recent))
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .sort((a, b) => b[1] - a[1]);
  const share = obj(format.state_tag).share_recent;

  const places: Place[] = [];
  for (const d of arr(readJson(`${sharedDir}rajasthan-places.json`).districts)) {
    const tag = str(d.tag);
    if (!tag) {
      problems.push("rajasthan-places.json: a district without a tag");
      continue;
    }
    places.push({ tag, terms: new XvTerms([...strs(d.hi), tag, ...arr(d.towns).map((t) => t.hi)]) });
  }
  const subject = readJson(`${sharedDir}subject-handles.json`);
  const exclusions = obj(subject.office_exclusion_lists).other_states;
  const otherStates = new XvTerms(Array.isArray(exclusions) ? strs(exclusions) : Object.values(obj(exclusions)).flatMap(strs));

  const tags: TagRule[] = [];
  for (const e of arr(readJson(`${videoDir}tags.json`).entries)) {
    const tag = str(e.tag);
    const kind = str(e.kind) ?? "topic";
    if (!tag || ["identifier", "brand", "state", "place"].includes(kind)) continue;
    const patterns: TagRule["patterns"] = [];
    for (const p of arr(e.patterns)) {
      const source = str(p.pattern);
      if (!source) continue;
      try {
        patterns.push({ re: new RegExp(plain(source), "iu"), start: str(p.start), end: str(p.end) });
      } catch (err) {
        problems.push(`tags.json ${tag}: pattern skipped (${(err as Error).message})`);
      }
    }
    const terms = new XvTerms([...strs(e.keywords_hi), ...strs(e.keywords_en)]);
    if (patterns.length || !terms.empty) tags.push({ tag, kind, terms, patterns });
  }

  // The breaking desk's handles, as build.py's load_shared reads them (each handle once; reporters apart)
  const handles: HandleRule[] = [];
  const reporters: HandleRule[] = [];
  const seen = new Set<string>();
  const put = (e: Json, kind: string, district: string | null, file: string) => {
    const handle = str(e.handle);
    if (!handle) return void problems.push(`${file}: an entry without a handle`);
    if (seen.has(handle.toLowerCase())) return;
    seen.add(handle.toLowerCase());
    handles.push({ handle, kind, district, terms: new XvTerms([...strs(e.names_hi), ...strs(e.names_en), ...strs(e.keywords_hi), ...strs(e.keywords_en)]) });
  };
  for (const e of arr(subject.entries)) put(e, str(e.kind) ?? "person", null, "subject-handles.json");
  for (const e of arr(readJson(`${sharedDir}party-handles.json`).entries)) put(e, "party", null, "party-handles.json");
  const dh = readJson(`${sharedDir}district-handles.json`);
  for (const e of arr(dh.state)) put(e, str(e.role) ?? "office", null, "district-handles.json");
  for (const [district, es] of Object.entries(obj(dh.districts))) for (const e of arr(es)) put(e, str(e.role) ?? "office", district, "district-handles.json");
  // A reporter is matched on the file's name even when another list names the same handle
  for (const e of arr(readJson(`${sharedDir}reporter-handles.json`).entries)) {
    const handle = str(e.handle);
    if (handle) reporters.push({ handle, kind: "reporter", district: null, terms: new XvTerms(strs(e.names_en)) });
  }

  return {
    places,
    otherStates,
    placeForm: forms[0]?.[0] ?? "#<City>",
    offerStateTag: typeof share !== "number" || share >= STATE_TAG_SHARE,
    tags,
    handles,
    reporters,
    problems,
  };
}

/** One part of the post: on = in the post as drafted (emit), off = offered for one click (suggest) */
export interface XvDraftPart {
  value: string;
  on: boolean;
  /** Why it is there (place, crime in the district, keyword, campaign, the model, the file's name) */
  why: string;
}

export interface XvComposeInput {
  /** The title line as known: the file name's heading (it may end in its own " | … News") or the model's headline */
  headline: string;
  /** The file's name without marks and extension: reporter handles are matched on it */
  fileTitle: string;
  /** The day folder's date, for campaign windows */
  day: string | null;
  /** What the model said from the screen read, when the headline came from it */
  model?: { district: string; state: string; topicHashtags: readonly string[] } | null;
}

export interface XvComposed {
  /** The Rajasthan district's tag ("Jaipur"), or null */
  district: string | null;
  region: "rajasthan" | "india";
  /** The title's ending: "Jaipur News", "Rajasthan News", the state outside Rajasthan, or the file name's own */
  channelLabel: string;
  hashtags: XvDraftPart[];
  mentions: XvDraftPart[];
}

const SUFFIX = /\s[|।]\s?/;

/** The district the title names (its " | …" ending first, then the headline), or whether it is outside Rajasthan */
function findPlace(text: string, dir: XvDirectory): { district: string | null; outside: boolean } {
  const parts = text.split(SUFFIX);
  for (const chunk of [...parts.slice(1), parts[0] ?? ""]) {
    const hit = dir.places.find((p) => p.terms.test(chunk));
    if (hit) return { district: hit.tag, outside: false };
  }
  return { district: null, outside: dir.otherStates.test(text) };
}

export function xvCompose(input: XvComposeInput, dir: XvDirectory): XvComposed {
  const text = plain(input.headline);
  let { district, outside } = findPlace(text, dir);
  const modelDistrict = (input.model?.district ?? "").trim().toLowerCase();
  const modelState = (input.model?.state ?? "").trim();
  if (!district && input.model) {
    const byModel = modelDistrict ? dir.places.find((p) => p.tag.toLowerCase() === modelDistrict) : undefined;
    if (byModel && !outside) district = byModel.tag;
    if (!byModel && modelState && modelState.toLowerCase() !== "rajasthan") outside = true;
  }
  const region = outside && !district ? "india" : "rajasthan";

  // The file name's own ending wins; else the district, the state outside Rajasthan, or Rajasthan
  const own = input.headline.split(SUFFIX).slice(1).join(" | ").trim();
  const outsideState = modelState && modelState.toLowerCase() !== "rajasthan" ? modelState : "India";
  const channelLabel = /News$/i.test(own) ? own : region === "india" ? `${outsideState} News` : district ? `${district} News` : "Rajasthan News";

  const hashtags: XvDraftPart[] = [];
  const addTag = (value: unknown, on: boolean, why: string) => {
    if (typeof value !== "string") return;
    const v = value.trim();
    if (!/^#\w+$/u.test(v)) return;
    const low = v.toLowerCase();
    if (low === IDENTIFIER.toLowerCase() || BRANDS.some((b) => b.toLowerCase() === low) || hashtags.some((h) => h.value.toLowerCase() === low)) return;
    hashtags.push({ value: v, on, why });
  };
  if (district) addTag(dir.placeForm === "#<City>News" ? `#${district}News` : `#${district}`, true, "place");
  if (region === "rajasthan" && dir.offerStateTag) addTag(STATE_TAG, false, "state");
  const day = input.day;
  for (const t of dir.tags) {
    const live = t.patterns.filter((p) => !p.start || (day !== null && p.start <= day && day <= (p.end ?? "9999-12-31")));
    if (live.some((p) => p.re.test(text)) || t.terms.test(text)) addTag(t.tag, false, t.kind);
  }
  for (const t of input.model?.topicHashtags ?? []) addTag(t, false, "model");

  const mentions: XvDraftPart[] = [];
  const addHandle = (value: string, on: boolean, why: string) => {
    if (!mentions.some((m) => m.value.toLowerCase() === value.toLowerCase())) mentions.push({ value, on, why });
  };
  for (const h of dir.handles) {
    if ((h.kind === "police" || h.kind === "collector") && h.district) {
      if (h.district !== district) continue;
      if (h.kind === "police" && CRIME.test(text)) addHandle(h.handle, true, `crime in ${district}`);
      if (h.kind === "collector" && DM_WORDS.test(text)) addHandle(h.handle, false, `administration in ${district}`);
      continue;
    }
    if (h.terms.test(text)) addHandle(h.handle, false, h.kind);
  }
  const fileName = plain(input.fileTitle);
  for (const r of dir.reporters) if (r.terms.test(fileName)) addHandle(r.handle, false, "the file's name");

  return { district, region, channelLabel, hashtags, mentions };
}

/**
 * The directory, loaded on first use and again when one of its files changes (step 6's learning rebuilds them).
 * Composes are cached per clip state (least recently used dropped first), so the desk's list polls cost nothing after
 * the first. A reload that fails keeps the last good directory; with none yet, nothing is composed.
 */
export class XvComposer {
  private dir: XvDirectory | null = null;
  private stamp = "";
  private checkedAt = Number.NEGATIVE_INFINITY;
  private readonly cache = new Map<string, XvComposed>();
  private lastError = "";

  constructor(
    private readonly videoDir = XV_DIRECTORY_FILES.videoDir,
    private readonly sharedDir = XV_DIRECTORY_FILES.sharedDir,
    private readonly maxCached = 5000,
    private readonly checkEveryMs = 30_000,
    /** Told once per new problem: a file that cannot be read, entries skipped */
    private readonly report: (message: string) => void = () => undefined,
  ) {}

  private stampNow(): string {
    return [...VIDEO_FILES.map((f) => `${this.videoDir}${f}`), ...SHARED_FILES.map((f) => `${this.sharedDir}${f}`)].map((f) => statSync(f).mtimeMs).join(":");
  }

  /** The current directory, or null when it has never loaded */
  directory(): XvDirectory | null {
    const now = Date.now();
    if (now - this.checkedAt < this.checkEveryMs) return this.dir;
    this.checkedAt = now;
    try {
      const stamp = this.stampNow();
      if (!this.dir || stamp !== this.stamp) {
        const dir = xvLoadDirectory(this.videoDir, this.sharedDir);
        this.dir = dir;
        this.stamp = stamp;
        this.cache.clear();
        this.lastError = "";
        if (dir.problems.length) this.report(`x videos directory loaded with ${dir.problems.length} entries skipped: ${dir.problems.slice(0, 5).join("; ")}`);
      }
    } catch (err) {
      const message = `x videos directory not reloaded (${this.dir ? "the last good one stays" : "nothing is composed until it loads"}): ${(err as Error).message}`;
      if (message !== this.lastError) this.report(message);
      this.lastError = message;
    }
    return this.dir;
  }

  compose(input: XvComposeInput): XvComposed | null {
    const dir = this.directory();
    if (!dir) return null;
    const key = JSON.stringify([input.headline, input.fileTitle, input.day, input.model ?? null]);
    const hit = this.cache.get(key);
    if (hit) {
      // Used again: to the back of the line
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const out = xvCompose(input, dir);
    if (this.cache.size >= this.maxCached) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, out);
    return out;
  }
}
