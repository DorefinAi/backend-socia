// Hashtag logic for a PUBLISHED-SHAPE post: split it into its slots, tell its format, resolve the brand
// tag and compose the tag set the desk would write (HASHTAG_HANDLE_CHANGES_v3, measured on 2,476 posts
// across six capture days). The replay harness scores with it; the breaking composer (compose.ts) uses
// the pieces that apply to a draft (URLs out, normalisation, the brand resolver, suggest-only inference).
//
// THE THREE FORMATS of a published post:
//   A  leading run      "#Jaipur #सांगानेर: <headline>"                 ← what the breaking composer writes
//   B  video post       "<headline> | Rajasthan News" / "Title: ..."   → #FINVideo first
//   C  trailing run     "<headline>\n...\n#Dungarpur #RajasthanWithFirstIndia"
//
// EMIT vs SUGGEST: `emit` goes on the post by itself, `suggest` waits for one desk click. A wrong emit
// costs a deletion on a live post, a missing one costs a click, so anything below ~85% reliable is a
// suggestion: #RajasthanNews and #<District>News on video posts, #ACB, campaign tags, an inferred district.
//
// PROVENANCE (b6 fix brief P0): a value either came from what the desk WROTE (explicit) or was worked out
// (inferred). `Sourced` carries that, and `emittable()` is the one gate an emit path goes through: an
// inferred value cannot reach the post however it was produced, so a new inference rule cannot leak by
// forgetting a check.

import { fold } from "../fold";

// ─── provenance ──────────────────────────────────────────────────────────────

export type Provenance = "explicit" | "inferred";

/** A value with where it came from */
export interface Sourced<T> {
  value: T;
  provenance: Provenance;
  /** Which slot or rule: "lead", "trail", "headline", "reporter", ... for the audit line and tests */
  from: string;
}

export const explicit = <T>(value: T, from: string): Sourced<T> => ({ value, provenance: "explicit", from });
export const inferred = <T>(value: T, from: string): Sourced<T> => ({ value, provenance: "inferred", from });
/** The value when it may go on the post by itself; null for an inferred one (that is a suggestion at most) */
export const emittable = <T>(s: Sourced<T> | null | undefined): T | null => (s && s.provenance === "explicit" ? s.value : null);

/**
 * A config file that is wrong is REJECTED WHOLE (b6 fix brief P5: "fail loudly, never silently correct"). The
 * worker keeps its last good copy and shows every problem in /ingest/status; skipping the bad entry and
 * loading the rest would be a silent correction: a misspelt campaign kind would quietly lose its tag, an
 * unchecked normalisation target would go into a post.
 */
export class DataFileRejected extends Error {
  constructor(readonly file: string, readonly problems: readonly string[]) {
    super(`${file}: ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.join("; ")}`);
    this.name = "DataFileRejected";
  }
}

// ─── text ─────────────────────────────────────────────────────────────────────

/** Newer X exports keep the trailing t.co link; it breaks the "line is only tags" test (§2.1) */
const URL = /https?:\/\/\S+/gu;
export const stripLinks = (text: string): string => text.replace(URL, "");

/**
 * One hashtag character: ASCII word characters, Devanagari (the danda । and double danda ॥ excluded, so
 * "#जयपुर।" ends at the name) and Latin-1 / Latin Extended-A/B for "#Nariño" (§2.6). JavaScript's \w is
 * ASCII-only, unlike Python's, so the Devanagari range has to be spelled out.
 */
const TAG_CHAR = String.raw`[\wऀ-ॣ०-ॿÀ-ɏ]`;
export const HASHTAG = new RegExp(`#(${TAG_CHAR}+)`, "gu");
/** A whole tag a config file may name: only hashtag characters, so a typo never puts a space or a colon in a post */
const WHOLE_TAG = new RegExp(`^${TAG_CHAR}+$`, "u");
const LEAD = new RegExp(String.raw`^\s*#(${TAG_CHAR}+)\s*:?\s*`, "u");
const TAG_ONLY_LINE = new RegExp(String.raw`^(?:[#@]${TAG_CHAR}+[\s,.]*)+$`, "u");
const DEVANAGARI = /[ऀ-ॿ]/u;

export const isDevanagari = (tag: string): boolean => DEVANAGARI.test(tag);
/** Every hashtag in the text, URLs ignored, without the # */
export const hashtagsIn = (text: string): string[] => [...stripLinks(text).matchAll(HASHTAG)].map((m) => m[1]!);

// ─── normalisation (§2.7) ─────────────────────────────────────────────────────

/** apps/worker/config/hashtag-normalise.json */
export interface HashtagNormaliseData {
  version?: number;
  /** Desk variant → canonical, without the # */
  variants: Record<string, string>;
  /** Tags a near-miss of which is flagged, never silently corrected */
  guarded?: string[];
  /**
   * The canonical spellings a variant may map to, as a person confirmed them. Every `variants` target must be
   * a guarded tag, one of these, or a tag the caller knows (a district): a typo in a TARGET would otherwise
   * be written into the post as the correction.
   */
  known?: string[];
}

export interface TagNormaliser {
  variants: ReadonlyMap<string, string>;
  guarded: readonly string[];
}

export const BRAND_RAJASTHAN = "RajasthanWithFirstIndia";
export const BRAND_NATIONAL = "FirstIndiaNews";
export const VIDEO_TAG = "FINVideo";
export const BRANDS: ReadonlySet<string> = new Set([BRAND_RAJASTHAN, BRAND_NATIONAL]);

export const EMPTY_NORMALISER: TagNormaliser = { variants: new Map(), guarded: [BRAND_RAJASTHAN, BRAND_NATIONAL, VIDEO_TAG] };

const bareTag = (t: string) => t.trim().replace(/^#+/, "");

/**
 * Checks a parsed hashtag-normalise.json. ANY problem rejects the whole file (DataFileRejected, every problem
 * listed): a pair that is not two tags, one that maps to itself, one whose target is not a known-good tag.
 * `problem` also hears each one as it is found. `knownTags`: more known-good tags (districts.json, say).
 */
export function parseHashtagNormalise(json: unknown, problem: (message: string) => void = () => undefined, knownTags: Iterable<string> = []): TagNormaliser {
  const root = json as Partial<HashtagNormaliseData> | null;
  if (!root || typeof root !== "object" || !root.variants || typeof root.variants !== "object" || Array.isArray(root.variants)) {
    throw new DataFileRejected("hashtag-normalise", ['expected { version, variants: { "FINVido": "FINVideo", ... }, known: [...] }']);
  }
  const problems: string[] = [];
  const fail = (m: string): void => {
    problems.push(m);
    problem(m);
  };
  const tagList = (v: unknown, where: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      fail(`${where}: must be a list of tags`);
      return [];
    }
    const out: string[] = [];
    v.forEach((x, i) => {
      if (typeof x === "string" && WHOLE_TAG.test(bareTag(x))) out.push(bareTag(x));
      else fail(`${where}[${i}]: "${String(x)}" is not a tag`);
    });
    return out;
  };
  const guarded = root.guarded === undefined ? [...EMPTY_NORMALISER.guarded] : tagList(root.guarded, "guarded");
  const known = new Set([...guarded, ...tagList(root.known, "known"), ...[...knownTags].map(bareTag)]);
  const variants = new Map<string, string>();
  for (const [from, to] of Object.entries(root.variants)) {
    if (from.startsWith("_")) continue;
    if (typeof to !== "string" || !WHOLE_TAG.test(bareTag(to)) || !WHOLE_TAG.test(bareTag(from))) {
      fail(`variants.${from}: must map to a tag`);
      continue;
    }
    if (bareTag(from) === bareTag(to)) {
      fail(`variants.${from}: maps to itself`);
      continue;
    }
    if (!known.has(bareTag(to))) {
      fail(`variants.${from}: the target #${bareTag(to)} is not a known-good tag (add it to "known" once a person has confirmed the spelling)`);
      continue;
    }
    variants.set(bareTag(from), bareTag(to));
  }
  if (problems.length) throw new DataFileRejected("hashtag-normalise", problems);
  return { variants, guarded };
}

/** Levenshtein distance, stopping early once it passes `max` */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

export interface NormalisedTag {
  /** Canonical tag, without the # */
  tag: string;
  /** Set when the desk's spelling differed: shown to the desk so the typo is seen, not hidden */
  flag?: string;
}

/**
 * The canonical spelling of a tag (§2.7). A known variant is corrected and flagged; a tag within edit
 * distance 2 of a guarded brand tag but not equal to it is flagged and LEFT AS IT IS — a near-miss is
 * reported, never silently corrected.
 */
export function normaliseTag(tag: string, n: TagNormaliser = EMPTY_NORMALISER): NormalisedTag {
  const bare = bareTag(tag);
  const to = n.variants.get(bare);
  if (to) return { tag: to, flag: `#${bare} → #${to}` };
  for (const g of n.guarded) {
    if (bare === g) return { tag: bare };
    if (editDistance(bare.toLowerCase(), g.toLowerCase(), 2) <= 2) return { tag: bare, flag: `#${bare} looks like #${g}` };
  }
  return { tag: bare };
}

// ─── places by tag (§5.1) ────────────────────────────────────────────────────

/** apps/worker/config/districts.json */
export interface DistrictsData {
  version?: number;
  /** Rajasthan district tags, current and abolished ones the desk still writes */
  rajasthan: string[];
  /** Places outside Rajasthan, as the desk writes them as tags */
  outside: string[];
  /** Tags that say "Rajasthan" without naming a district (#Rajasthan, #RajasthanPolice, ...) */
  rajasthanSignals?: string[];
}

export interface TagPlaces {
  /** Lower-cased tag → canonical tag */
  rajasthan: ReadonlyMap<string, string>;
  outside: ReadonlyMap<string, string>;
  signals: ReadonlySet<string>;
}

export const EMPTY_TAG_PLACES: TagPlaces = { rajasthan: new Map(), outside: new Map(), signals: new Set() };

/** Checks a parsed districts.json. Throws on a malformed root; a tag in both lists is reported and kept as Rajasthan. */
export function parseDistricts(json: unknown, problem: (message: string) => void = () => undefined): TagPlaces {
  const root = json as Partial<DistrictsData> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.rajasthan) || !Array.isArray(root.outside)) {
    throw new Error("districts: expected { version, rajasthan: [...], outside: [...] }");
  }
  const list = (v: unknown[]) => v.filter((x): x is string => typeof x === "string" && !!bareTag(x)).map((x) => bareTag(x).normalize("NFC"));
  const rajasthan = new Map(list(root.rajasthan).map((t) => [t.toLowerCase(), t]));
  const outside = new Map<string, string>();
  for (const t of list(root.outside)) {
    if (rajasthan.has(t.toLowerCase())) problem(`outside: ${t} is also a Rajasthan district (kept as Rajasthan)`);
    else outside.set(t.toLowerCase(), t);
  }
  const signals = new Set(list(Array.isArray(root.rajasthanSignals) ? root.rajasthanSignals : []).map((t) => t.toLowerCase()));
  return { rajasthan, outside, signals };
}

export type PlaceKind = "rajasthan" | "outside";

/**
 * Which side of the border a Latin tag names, or null: the replay reads districts.json (TagPlaces), the live
 * composer its places file (compose.ts bookPlaceKind). videoLabelBrand takes either.
 */
export type PlaceKindLookup = (tag: string) => PlaceKind | null;

/** Which list a tag is on, also through its "#<Place>News" stem ("#JaipurNews" → Jaipur) */
export function tagPlace(tag: string, places: TagPlaces): { kind: PlaceKind; place: string } | null {
  const look = (t: string) => {
    const k = t.toLowerCase();
    const r = places.rajasthan.get(k);
    if (r) return { kind: "rajasthan" as const, place: r };
    const o = places.outside.get(k);
    return o ? { kind: "outside" as const, place: o } : null;
  };
  return look(tag) ?? (/^.+News$/.test(tag) && !BRANDS.has(tag) ? look(tag.slice(0, -4)) : null);
}

/** A tag that says Rajasthan without naming a district: listed, or any "#Rajasthan…" tag but the brand */
const isRajasthanSignal = (tag: string, places: TagPlaces) =>
  places.signals.has(tag.toLowerCase()) || (/^Rajasthan(?:[A-Z0-9]|$)/.test(tag) && tag !== BRAND_RAJASTHAN);

// ─── segmentation and format ─────────────────────────────────────────────────

export interface Segmented {
  /** Hashtags before the headline: the district, then the town */
  lead: string[];
  /** Hashtags on the tag-only lines after the body */
  trail: string[];
  /** Hashtags anywhere else */
  inline: string[];
  /** Line 1 with the leading run taken off */
  headline: string;
  /** The body lines that are not a tag line */
  points: string[];
}

/** Splits a published post into its slots. URLs are taken out first: they would break the tag-line test (§2.1). */
export function segmentPost(raw: string): Segmented {
  const text = stripLinks(raw);
  const lines = text.split("\n");
  let headline = lines[0] ?? "";
  const lead: string[] = [];
  for (;;) {
    const m = LEAD.exec(headline);
    if (!m) break;
    lead.push(m[1]!);
    headline = headline.slice(m[0].length);
  }
  const trail: string[] = [];
  const points: string[] = [];
  for (const line of lines.slice(1)) {
    const s = line.trim();
    if (!s) continue;
    if (TAG_ONLY_LINE.test(s)) trail.push(...[...s.matchAll(HASHTAG)].map((m) => m[1]!));
    else points.push(s);
  }
  const taken = new Set([...lead, ...trail]);
  const inline = [...text.matchAll(HASHTAG)].map((m) => m[1]!).filter((h) => !taken.has(h));
  return { lead, trail, inline, headline: headline.trim(), points };
}

/**
 * A video headline (§2.2): "<title> | Rajasthan News", "<title>। Madhya Pradesh News" — the separator needs
 * a space AFTER it only, because standard Hindi attaches the danda to the word before it — or the Latin
 * title-case colon form "Jaipur Diwali Fair: ...". "Breaking News:" and "Rajasthan News Live:" are not videos.
 */
export function isVideoHeadline(line1: string): boolean {
  const h = stripLinks(line1);
  if (/^\s*(?:Breaking News|Rajasthan News Live)\s*:/u.test(h)) return false;
  return /[|।]\s/u.test(h) || /^[A-Za-z0-9][A-Za-z0-9 .'&-]{3,60}:\s/u.test(h);
}

/**
 * The ONE implementation of the video channel-label brand (V1): the live composer (composeBreaking) and the replay
 * reference (resolveBrand, composePostTags) both call it.
 * The brand a video headline's channel label names, or null when it names none (§2.2). The label is what follows
 * the LAST "|" or "।" separator: "<title> | Rajasthan News" and "<title> | Jaipur News" are Rajasthan (a label that
 * starts with "Rajasthan" or with a Rajasthan district: "Sikar Crime News", "Sawai Madhopur"); "| Madhya Pradesh
 * News", "| India News", "| Delhi News", "| Hindi News" — any other "<…> News" label, or a place on the outside
 * list — are national. Anything else ("| BJP Padyatra", a Hindi clause after a danda, the colon form) is not a
 * channel label, and the caller keeps its own default.
 */
export function videoLabelBrand(line1: string, places: TagPlaces | PlaceKindLookup = EMPTY_TAG_PLACES): typeof BRAND_RAJASTHAN | typeof BRAND_NATIONAL | null {
  const kindOf: PlaceKindLookup = typeof places === "function" ? places : (t) => tagPlace(t, places)?.kind ?? null;
  const h = stripLinks(line1).replace(new RegExp(`(?:\\s+#${TAG_CHAR}+)+\\s*$`, "u"), "").trim();
  const cut = Math.max(h.lastIndexOf("|"), h.lastIndexOf("।"));
  if (cut < 0) return null;
  const label = h.slice(cut + 1).trim();
  // A Latin label only: a Hindi clause after a danda is the headline going on, not the channel's label
  if (!/^[A-Za-z][A-Za-z0-9 .&'-]*$/.test(label)) return null;
  const words = label.replace(/\s+news$/i, "").split(/\s+/).filter(Boolean);
  if (/^rajasthan$/i.test(words[0] ?? "")) return BRAND_RAJASTHAN;
  // The longest run of leading words that is a place tag: "Sawai Madhopur", "SriGanganagar", "Sikar" (of "Sikar Crime")
  for (let n = words.length; n >= 1; n--) {
    const kind = kindOf(words.slice(0, n).join(""));
    if (kind) return kind === "rajasthan" ? BRAND_RAJASTHAN : BRAND_NATIONAL;
  }
  return /\snews$/i.test(label) ? BRAND_NATIONAL : null;
}

export type PostFormat = "A" | "B" | "C";

export function postFormat(text: string): PostFormat {
  if (segmentPost(text).lead.length) return "A";
  return isVideoHeadline(text.split("\n")[0] ?? "") ? "B" : "C";
}

// ─── brand (§2.3) ─────────────────────────────────────────────────────────────

export interface BrandInput {
  /** The leading slot, normalised (format A) */
  lead?: string | null;
  /** The trailing and inline tags, normalised */
  trail?: readonly string[];
  video: boolean;
  /**
   * The default when nothing resolves. Omitted: #RajasthanWithFirstIndia on a video post, #FirstIndiaNews
   * otherwise (step 6 — measured; defaulting format A/C to Rajasthan costs 4 posts on the 1K). The breaking
   * composer passes the parser's judgement instead: a Rajasthan desk's file with no place is Rajasthan copy.
   */
  fallback?: typeof BRAND_RAJASTHAN | typeof BRAND_NATIONAL;
  /**
   * A video post's line 1: its channel label ("| Madhya Pradesh News") replaces the video default at step 6 only
   * (videoLabelBrand). A place tag in any slot still decides first.
   */
  headline?: string;
}

export interface BrandResult {
  brand: typeof BRAND_RAJASTHAN | typeof BRAND_NATIONAL;
  /** Which step decided, for tests and the audit line */
  step: 1 | 2 | 3 | 4 | 5 | 6;
  /** A Latin leading tag on neither list: raised, and NOT taken as outside Rajasthan (that would flip the brand) */
  unknownDistrict?: string;
}

/** The brand tag from the story's geography, any slot, in the measured order */
export function resolveBrand(input: BrandInput, places: TagPlaces): BrandResult {
  let unknownDistrict: string | undefined;
  const lead = input.lead && !isDevanagari(input.lead) ? input.lead : null;
  if (lead) {
    const p = tagPlace(lead, places);
    if (p?.kind === "rajasthan") return { brand: BRAND_RAJASTHAN, step: 1 };
    if (p?.kind === "outside") return { brand: BRAND_NATIONAL, step: 2 };
    if (!isRajasthanSignal(lead, places)) unknownDistrict = lead;
  }
  const trail = (input.trail ?? []).filter((t) => !BRANDS.has(t) && t !== VIDEO_TAG);
  const out = (r: Omit<BrandResult, "unknownDistrict">): BrandResult => (unknownDistrict ? { ...r, unknownDistrict } : r);
  if (trail.some((t) => tagPlace(t, places)?.kind === "rajasthan")) return out({ brand: BRAND_RAJASTHAN, step: 3 });
  if ((lead && isRajasthanSignal(lead, places)) || trail.some((t) => isRajasthanSignal(t, places))) return out({ brand: BRAND_RAJASTHAN, step: 4 });
  if (trail.some((t) => tagPlace(t, places)?.kind === "outside")) return out({ brand: BRAND_NATIONAL, step: 5 });
  const videoDefault = () => (input.headline ? videoLabelBrand(input.headline, places) : null) ?? BRAND_RAJASTHAN;
  return out({ brand: input.fallback ?? (input.video ? videoDefault() : BRAND_NATIONAL), step: 6 });
}

// ─── suggestion rules (§4.1, §5.4) ───────────────────────────────────────────

/** One entry of apps/worker/config/campaigns.json */
export interface SuggestRuleEntry {
  tag: string;
  /** A regular expression over the post text (Hindi and English) */
  pattern: string;
  /** "campaign" needs explicit start and end dates (YYYY-MM-DD, IST, inclusive); "keyword" is evergreen */
  kind?: "campaign" | "keyword";
  start?: string;
  end?: string;
  note?: string;
}

export interface SuggestRule {
  tag: string;
  pattern: RegExp;
  start: string | null;
  end: string | null;
}

export interface SuggestRules {
  rules: readonly SuggestRule[];
}

export const EMPTY_SUGGEST_RULES: SuggestRules = { rules: [] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_KINDS: ReadonlySet<string> = new Set(["campaign", "keyword"]);

/** campaigns.json patterns run on every story's text: a short, fast regular expression or the file is refused */
export const MAX_PATTERN = 300;
/** Per adversarial input, after which the pattern is called too slow */
const PATTERN_BUDGET_MS = 25;
/**
 * Why a pattern is too slow, or null. JavaScript cannot stop a regular expression once it runs, so it is tried on
 * inputs that grow (catastrophic backtracking shows at a few dozen characters, long before it hangs) and stops at
 * the first one over budget: repeated letters, Devanagari, spaces and digits, each ending in a character that
 * makes the match fail late.
 */
export function slowPattern(pattern: RegExp): string | null {
  const units = ["a", "आ", " ", "1", "a ", "आ ", "aa1", "#a"];
  for (const n of [8, 16, 24, 28, 32, 64, 1000, 5000]) {
    for (const u of units) {
      for (const end of ["!", "", "।"]) {
        const input = u.repeat(n) + end;
        const t = performance.now();
        pattern.test(input);
        const ms = performance.now() - t;
        if (ms > PATTERN_BUDGET_MS) return `${Math.round(ms)} ms on ${n} × "${u}"`;
      }
    }
  }
  return null;
}

/**
 * Checks a parsed campaigns.json. ANY problem rejects the whole file (DataFileRejected, every problem listed):
 * an unknown or missing kind (a misspelt "campain" must neither turn a dated campaign into a tag offered every
 * day nor quietly drop it), a campaign without explicit dates (its window is never inferred from which export
 * a post came from: #RajasthanPanchayatElection2026 is in both the October and the November files), a
 * reversed window, a tag that is not a hashtag, a pattern that does not compile, is longer than MAX_PATTERN or is
 * too slow on adversarial input (slowPattern).
 */
export function parseSuggestRules(json: unknown, problem: (message: string) => void = () => undefined): SuggestRules {
  const root = json as { entries?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.entries)) throw new DataFileRejected("campaigns", ["expected { version, entries: [...] }"]);
  const rules: SuggestRule[] = [];
  const problems: string[] = [];
  const fail = (m: string): void => {
    problems.push(m);
    problem(m);
  };
  (root.entries as Partial<SuggestRuleEntry>[]).forEach((e, i) => {
    const where = `entries[${i}]`;
    if (!e || typeof e.tag !== "string" || !WHOLE_TAG.test(bareTag(e.tag))) return fail(`${where}: no tag, or not a valid hashtag`);
    if (typeof e.pattern !== "string" || !e.pattern) return fail(`${where} (${e.tag}): no pattern`);
    if (e.pattern.length > MAX_PATTERN) return fail(`${where} (${e.tag}): pattern is ${e.pattern.length} characters, more than ${MAX_PATTERN}`);
    let pattern: RegExp;
    try {
      pattern = new RegExp(e.pattern, "u");
    } catch (err) {
      return fail(`${where} (${e.tag}): pattern does not compile: ${(err as Error).message}`);
    }
    const slow = slowPattern(pattern);
    if (slow) return fail(`${where} (${e.tag}): pattern is too slow (${slow}); it runs on every story, rewrite it without nested repeats`);
    // Spelled out, never defaulted: a missing kind is as much a typo as a misspelt one
    if (typeof e.kind !== "string" || !KNOWN_KINDS.has(e.kind)) return fail(`${where} (${e.tag}): kind must be "campaign" or "keyword", not ${JSON.stringify(e.kind)}`);
    const kind = e.kind;
    if (kind === "campaign" && !(typeof e.start === "string" && DATE.test(e.start) && typeof e.end === "string" && DATE.test(e.end))) {
      return fail(`${where} (${e.tag}): a campaign needs "start" and "end" as YYYY-MM-DD`);
    }
    if (kind === "campaign" && e.start! > e.end!) return fail(`${where} (${e.tag}): "start" is after "end", so it would never be offered`);
    rules.push({ tag: bareTag(e.tag), pattern, start: kind === "campaign" ? e.start! : null, end: kind === "campaign" ? e.end! : null });
  });
  if (problems.length) throw new DataFileRejected("campaigns", problems);
  return { rules };
}

/** The IST calendar day of an instant, YYYY-MM-DD */
export const istDate = (at: Date): string => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Tags the rules match in the text on that day, without the #. Always suggestions, never emitted. */
export function suggestTags(text: string, rules: SuggestRules, at: Date): string[] {
  const day = istDate(at);
  const clean = stripLinks(text).normalize("NFC");
  return rules.rules.filter((r) => (!r.start || (day >= r.start && day <= r.end!)) && r.pattern.test(clean)).map((r) => r.tag);
}

// ─── the reference composer ──────────────────────────────────────────────────

export interface PostTagContext {
  places: TagPlaces;
  normaliser?: TagNormaliser;
  suggestRules?: SuggestRules;
  /** The post's time, for campaign windows; none: campaign rules are not applied */
  at?: Date;
  /**
   * District inference for a post with no district in any slot (§2.8): the Devanagari gazetteer over the
   * headline, then the filing reporter's single district. Whatever it returns is a SUGGESTION, never emitted.
   */
  inferDistrict?: (headline: string) => string | null;
  /** Evergreen topic tags that are emitted (precise enough to auto-apply) */
  topics?: readonly { tag: string; pattern: RegExp }[];
  /**
   * The filing reporter's desk rule (reporter-prior brief §4): the district tag ("Jaipur") a post gets when the desk
   * wrote no place — as the leading tag on a standard post, offered (never a leading tag) on a video post. From the
   * file name's reporter only. The same rule as composeBreaking: only what the DESK wrote blocks it (a place in any
   * slot, "#<Place>News" included; its own leading tag run; a place before the headline's colon, see
   * `deskPlacePrefix`). A district the gazetteer infers does NOT block it, and it never changes the brand.
   */
  reporterPolicy?: string | null;
  /**
   * Whether the desk wrote a place before the headline's colon ("रामपुरा खुर्द: ..."): composeBreaking's R3 check,
   * given here by a caller that has the places file (parse.ts deskPlacePrefix and isHeadlineLabel). None: not checked.
   */
  deskPlacePrefix?: (headline: string) => boolean;
  /**
   * The district a Hindi leading tag names through the town→district table ("#किशनगढ़:" → "Ajmer"), or null for a
   * place the table does not know ("#आकोला:"): compose.ts bookLeadTagDistrict. A TAG the desk wrote, so it decides
   * the brand as composeBreaking's stated district does (N3); it is not emitted. A town only in the headline's TEXT
   * never reaches this (FL5). None: a Hindi leading tag decides nothing, as before.
   */
  leadTagDistrict?: (tag: string) => string | null;
  /**
   * The Latin place tag a Hindi place name is ("जोधपुर" → "Jodhpur"), from a caller that has the places file
   * (parse.ts hindiPlaceTag). With it a Hindi "#<स्थान>न्यूज़" tag reads exactly as "#<Place>News" does (C-c), as
   * composeBreaking reads it. None: Hindi news tags are read as written (no place).
   */
  hindiPlace?: (name: string) => string | null;
}

/** "#जोधपुरन्यूज़", "#जोधपुरन्यूज", "#जोधपुरसमाचार": the Hindi "<Place>News" form; the same stems as parse.ts placeOfTag */
const HINDI_NEWS_STEM = /^(.+?)_?(?:न्यूज़?|समाचार)$/u;
/** A Hindi "<स्थान>न्यूज़" tag as its Latin "<Place>News" form when the stem is a known place, else the tag as written */
export function hindiNewsAsLatin(tag: string, hindiPlace: PostTagContext["hindiPlace"]): string {
  if (!hindiPlace || !isDevanagari(tag)) return tag;
  const stem = HINDI_NEWS_STEM.exec(tag.normalize("NFC"))?.[1];
  const place = stem ? hindiPlace(stem) : null;
  return place ? `${place}News` : tag;
}

export interface PostTags {
  format: PostFormat;
  /** The district the post's slots name (normalised), or null. Always explicit: an inferred one is only in `suggest`. */
  district: string | null;
  lead: string[];
  /** Emitted in the desk's order: #FINVideo → district → brand → topic tags (§2.5) */
  trail: string[];
  suggest: string[];
  /** Normalisation flags and unknown_district, for the desk to see */
  flags: string[];
  /** The reporter's desk rule fired: "emit" (the leading tag) or "suggest" (a video post); null when it did not */
  policy: "emit" | "suggest" | null;
}

/** The district the slots name: the Latin leading tag, else the first trailing tag on a place list */
export function slotDistrict(s: Segmented, ctx: Pick<PostTagContext, "places" | "normaliser">): string | null {
  const n = (t: string) => normaliseTag(t, ctx.normaliser).tag;
  if (s.lead[0] && !isDevanagari(s.lead[0])) return n(s.lead[0]);
  for (const t of s.trail.map(n)) {
    const p = tagPlace(t, ctx.places);
    if (p) return p.place;
  }
  return null;
}

/** Whether any slot (lead, trail or inline, "#<Place>News" stems included) names a place on districts.json */
export function namesAPlace(s: Segmented, ctx: Pick<PostTagContext, "places" | "normaliser">): boolean {
  return [...s.lead, ...s.trail, ...s.inline].some((t) => !isDevanagari(t) && tagPlace(normaliseTag(t, ctx.normaliser).tag, ctx.places) !== null);
}

/** The tags the desk would put on this post: emitted (lead, trail) and offered (suggest) */
export function composePostTags(text: string, ctx: PostTagContext): PostTags {
  const seg = segmentPost(text);
  // A Hindi "#जोधपुरन्यूज़" is read as "#JodhpurNews" in every slot (C-c), so it counts wherever that tag counts
  const h = (t: string) => hindiNewsAsLatin(t, ctx.hindiPlace);
  const s: Segmented = ctx.hindiPlace ? { ...seg, lead: seg.lead.map(h), trail: seg.trail.map(h), inline: seg.inline.map(h) } : seg;
  const flags: string[] = [];
  const n = (t: string) => {
    const r = normaliseTag(t, ctx.normaliser);
    if (r.flag && !flags.includes(r.flag)) flags.push(r.flag);
    return r.tag;
  };
  const line1 = stripLinks(text).split("\n")[0] ?? "";
  const format: PostFormat = s.lead.length ? "A" : isVideoHeadline(line1) ? "B" : "C";
  const video = isVideoHeadline(line1);
  const trailNorm = [...s.trail, ...s.inline].map(n);
  const leadNorm = s.lead.map((t, i) => (i === 0 && !isDevanagari(t) ? n(t) : t));
  // The district with its provenance: the slots are what the desk wrote (explicit); §2.8 inference is not,
  // and is only ever offered. P1: no inference at all when the post names a place in any slot.
  const slot = slotDistrict(s, ctx);
  const inferredDistrict = !slot && ctx.inferDistrict && !namesAPlace(s, ctx) ? ctx.inferDistrict(s.headline) : null;
  const district: Sourced<string> | null = slot ? explicit(slot, "slot") : inferredDistrict ? inferred(inferredDistrict, "headline") : null;
  const d = emittable(district);
  const place = d ? tagPlace(d, ctx.places) : null;

  // The reporter's desk rule, as composeBreaking applies it: only what the desk WROTE blocks it — a place in any slot,
  // its own leading tag run (format A), a place before the headline's colon. The gazetteer's inference does not (user
  // decision, 13 Nov). Video format has no leading run, so there it is offered in the trailing run instead.
  const deskWrotePlace = format === "A" || !!slot || namesAPlace(s, ctx) || (ctx.deskPlacePrefix?.(s.headline) ?? false);
  const policyTag = ctx.reporterPolicy && !deskWrotePlace ? ctx.reporterPolicy : null;
  const policy: PostTags["policy"] = policyTag ? (video ? "suggest" : "emit") : null;
  const lead: string[] = [];
  if (format === "A") {
    lead.push(leadNorm[0]!);
    if (leadNorm[1] && isDevanagari(leadNorm[1])) lead.push(leadNorm[1]);
  } else if (policy === "emit") lead.push(policyTag!);
  // The desk rule's tag means "filed from that desk", not where the story is: it never decides the brand
  // A Hindi leading tag the town→district table knows ("#किशनगढ़:") decides as its district would (N3)
  const lead0 = format === "A" ? leadNorm[0]! : null;
  const brandLead = lead0 && isDevanagari(lead0) ? (ctx.leadTagDistrict?.(lead0) ?? lead0) : lead0;
  const brand = resolveBrand({ lead: brandLead, trail: trailNorm, video, headline: line1 }, ctx.places);
  if (brand.unknownDistrict) flags.push(`unknown_district:${brand.unknownDistrict}`);

  const trail: string[] = [];
  const suggest: string[] = [];
  if (video) trail.push(VIDEO_TAG);
  // Format C carries the district in the trailing run, out-of-state places included (§2.4), BEFORE the brand
  // (§2.5). The guard the change spec asks for, spelled out: only an EXPLICIT district on a place list, so an
  // inferred one cannot leak here (it did once, and cost 0.3 points on every day).
  if (format === "C" && place && district?.provenance === "explicit") trail.push(place.place);
  trail.push(brand.brand);
  if (format === "B") {
    // Not reliable enough on video posts to emit (54.9% and 11–65% by day): offered
    if (place) suggest.push(place.kind === "rajasthan" ? `${place.place}News` : place.place, place.place);
    suggest.push("RajasthanNews");
  }
  const body = [s.headline, ...s.points].join("\n");
  for (const t of ctx.topics ?? []) if (t.pattern.test(body) && !trail.includes(t.tag)) trail.push(t.tag);

  // §2.8: an inferred district is offered, never emitted
  if (district?.provenance === "inferred") suggest.push(district.value);
  if (policy === "suggest") suggest.push(policyTag!);
  if (ctx.suggestRules && ctx.at) suggest.push(...suggestTags(body, ctx.suggestRules, ctx.at));
  const emitted = new Set([...lead, ...trail].map((t) => fold(t)));
  const offered = [...new Set(suggest)].filter((t) => !emitted.has(fold(t)));
  return { format, district: d, lead, trail, suggest: offered, flags, policy };
}
