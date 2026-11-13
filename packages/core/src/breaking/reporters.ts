// 1st India's own reporters, keyed on the token in the breaking file name.
//
// THE JOIN KEY IS THE LATIN FILE-NAME TOKEN, not a Devanagari name. filename.ts already pulls the
// reporter slot out of the name (`BTN_RJ_BREAKING_6001_30OCT_US_CONTROL_Rituraj_Meeting_BIG` →
// "RITURAJ"); this file only answers "which reporter, if any, does that token name?".
//
// MEASURED ON THIS DESK'S OWN FILES (6,878 breaking files already ingested, 30 Oct – 10 Nov 2026):
//   64.1% carry a reporter token, across 143 distinct spellings.
// MEASURED ON PUBLISHED OUTPUT (1,002 posts): 339 of 1,250 handle uses were a reporter — 27%, second
// only to district police — and the reporter was the LAST handle in 290 of 339 placements (85.5%).
//
// WHEN IT FIRES: on political, government and other copy, not on incidents. Share of posts that added a
// reporter alongside each role: party 65.7%, govt/dept 63.8%, politician 57.6%, police 14.6%,
// collector 6.0%. That asymmetry lives in handles.ts, not here.
//
// TWO RULES THAT KEEP A WRONG BYLINE OFF A POST:
//
//   1. A TOKEN THE ROSTER DOES NOT CARRY TAGS NOBODY. It is never guessed at, never fuzzy-matched. The
//      token comes back as `unmatchedToken` so the desk can see it and complete the roster — that is the
//      whole point of reading the file-name grammar, and the log it produces is the roster's to-do list.
//   2. A TOKEN TWO REPORTERS CLAIM TAGS NEITHER. Tokens are short and some are bare first names; the
//      moment there are two of them, picking the first means tagging the wrong colleague.
//
// HOW THE ROSTER GROWS: when an editor adds a reporter's handle to a draft by hand, the desk layer
// records the story's file-name token against that handle (handle_directory, source "reporter"), and
// those learned tokens are merged in by `mergeReporterTokens`. The list completes itself from use.

import { fold } from "../fold";
import { HANDLE } from "./syntax";
import { DataFileRejected } from "./post-tags";

/** One entry of reporter-handles.json */
export interface ReporterHandleEntry {
  /** "@omsharma8888" (the @ is optional) */
  handle: string;
  /** For the draft's "why this handle" line. May be empty; the handle is then used. */
  name?: string;
  /**
   * EVERY Latin token spelling that appears in a file name, misspellings included. This is the join key.
   * Case, spaces and underscores are ignored. A token missing here means this reporter is never tagged.
   */
  names_en?: string[];
  /** Devanagari spellings. NOT matched against — kept for the library UI and for auditing. */
  names_hi?: string[];
  /** The desk's beat and district labels. Not matched against; used to flag a district mismatch. */
  beats?: string[];
  districts?: string[];
  /** Who said the beats: "desk" (the X team told us) or "observed" (measured). Display only. */
  beats_source?: "desk" | "observed";
  /** A standing desk rule for this reporter (reporter-prior brief §4). Absent for almost everyone. */
  policy?: { district_when_missing?: string };
  /** Measured rates for the reporter-routing prior (§3.3): seeded from the corpus, refreshed from the decision log */
  prior?: ReporterPriorData;
  verified: boolean;
  /** X's numeric user id. Handles get renamed and recycled; the id is what identifies the account. */
  xUserId?: string;
  source?: string;
  evidence?: number;
  checkedAt?: string;
  note?: string;
}

/** One reporter's measured rates: handle (no @) or "#Tag" → share of their posts carrying it */
export interface ReporterPriorData {
  computed_at?: string;
  /** Where the numbers came from. Seed values are an UPPER BOUND (brief L2): say so here. */
  source?: string;
  /** The reporter's posts the rates rest on */
  n: number;
  handles?: Record<string, number>;
  hashtags?: Record<string, number>;
}

export interface ReporterHandlesData {
  version: number;
  entries: ReporterHandleEntry[];
  /**
   * Tokens that name more than one reporter ("DINESH": Dangi and Kasana). Never matched, whoever claims them:
   * resolved as "collision", tagging nobody — the wrong colleague is worse than none.
   */
  ambiguous_tokens?: string[];
  /** The smoothing and threshold of the prior (§3.4) */
  prior_settings?: { m?: number; min_score?: number; min_n?: number };
  /** The share of ALL posts carrying each handle (no @) or "#Tag": what a small sample is pulled towards */
  prior_base_rates?: Record<string, number>;
}

/** What the prior and the policy know about one reporter, by handle */
export interface ReporterProfile {
  /** Handle without the @ */
  handle: string;
  name: string;
  beats: string[];
  beatsSource: "desk" | "observed" | null;
  /** The district a post with none gets, as a line-1 hashtag only (§4) */
  districtWhenMissing: string | null;
  prior: { n: number; handles: Record<string, number>; hashtags: Record<string, number>; source: string | null } | null;
}

export interface PriorSettings {
  m: number;
  minScore: number;
  minN: number;
  /** Lower-cased handle (no @) or "#tag" → base rate */
  base: ReadonlyMap<string, number>;
}

export const DEFAULT_PRIOR_SETTINGS: Readonly<PriorSettings> = Object.freeze({ m: 20, minScore: 0.25, minN: 20, base: new Map<string, number>() });

export interface ReporterMatch {
  /** Handle without the @ */
  handle: string;
  name: string;
  /** Districts the desk associates with this reporter, for the mismatch warning */
  districts: string[];
}

export interface ReporterRules {
  /** Upper-cased Latin token → entry. A token two entries claimed is absent on purpose. */
  byToken: Map<string, ReporterMatch>;
  /** Tokens dropped because more than one reporter claimed them */
  conflicts: Set<string>;
  count: number;
  /** Every handle in the file, verified or not, lower-cased without the @ (the desk-handles guard) */
  handles?: ReadonlySet<string>;
  /**
   * The VERIFIED handles only, lower-cased without the @. This is the set an editor may add by hand and
   * the only set a file-name token may be learned against: an entry the desk has left unverified — one
   * whose handle it has not decided about — must not become taggable because somebody put it on a post.
   */
  verifiedHandles?: ReadonlySet<string>;
  /** Verified reporters' beats, policy and prior, by lower-cased handle without the @ */
  profiles?: ReadonlyMap<string, ReporterProfile>;
  /** The file's ambiguous_tokens, as keys: always "collision" */
  ambiguous?: ReadonlySet<string>;
  prior?: PriorSettings;
}

export const EMPTY_REPORTER_RULES: ReporterRules = { byToken: new Map(), conflicts: new Set(), count: 0 };

/** The profile of a matched reporter, or null */
export const reporterProfile = (rules: ReporterRules, m: ReporterMatch | null | undefined): ReporterProfile | null =>
  (m && rules.profiles?.get(m.handle.toLowerCase())) ?? null;

const rate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
/** A prior's rates, by handle (no @) or "#Tag": a null-prototype record, so "constructor" or "__proto__" is only ever a key */
const rates = (v: unknown, where: string, problem: (m: string) => void): Record<string, number> => {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  if (v === undefined) return out;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    problem(`${where}: must be { "Handle": 0.62, ... }`);
    return out;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    if (!rate(x)) problem(`${where}.${k}: ${String(x)} is not a share between 0 and 1`);
    else out[k.replace(/^@/, "")] = x;
  }
  return out;
};

/**
 * What a reporter's `prior` may name, beyond being well-formed (parseReporterHandles' `check`). Both lower-cased
 * without the @. A handle outside `directory`, or inside `bound`, rejects the whole file.
 */
export interface ReporterPriorCheck {
  /** Every handle the OTHER directory files carry (this file's own handles are added) */
  directory?: ReadonlySet<string>;
  /** Every police and collector handle, verified or not (HandleRules.bound): a reporter never brings one */
  bound?: ReadonlySet<string>;
}

/**
 * A reporter's profile. A malformed `prior` (no finite sample size, a rate outside 0..1, a handle outside the
 * directory or a police / collector handle) goes to `reject` and fails the whole file; an unknown beats_source is
 * a warning.
 */
function parseProfile(e: ReporterHandleEntry, handle: string, name: string, where: string, problem: (m: string) => void, reject: (m: string) => void, check: ReporterPriorCheck): ReporterProfile {
  let prior: ReporterProfile["prior"] = null;
  if (e.prior !== undefined) {
    const p = e.prior as Partial<ReporterPriorData> | null;
    if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.n !== "number" || !Number.isFinite(p.n) || p.n < 0) reject(`${where}: "prior" needs a finite sample size "n" of 0 or more`);
    else {
      const handles = rates(p.handles, `${where}.prior.handles`, reject);
      for (const h of Object.keys(handles)) {
        const lc = h.toLowerCase();
        if (check.bound?.has(lc)) reject(`${where}.prior.handles: @${h} is a district police, collector or state police handle — a reporter never brings one (brief §3.5)`);
        else if (check.directory && !check.directory.has(lc)) reject(`${where}.prior.handles: @${h} is in no directory file — a handle is never invented`);
      }
      prior = { n: p.n, handles, hashtags: rates(p.hashtags, `${where}.prior.hashtags`, reject), source: typeof p.source === "string" ? p.source : null };
    }
  }
  if (e.beats_source !== undefined && e.beats_source !== "desk" && e.beats_source !== "observed") {
    problem(`${where}: beats_source "${String(e.beats_source)}" is neither "desk" nor "observed"; its beats offer nothing`);
  }
  const dwm = e.policy?.district_when_missing;
  return {
    handle, name, beats: strings(e.beats), beatsSource: e.beats_source === "desk" || e.beats_source === "observed" ? e.beats_source : null,
    districtWhenMissing: typeof dwm === "string" && dwm.trim() ? dwm.trim() : null, prior,
  };
}

function parsePriorSettings(root: Partial<ReporterHandlesData>, reject: (m: string) => void): PriorSettings {
  const raw: unknown = root.prior_settings;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) reject(`prior_settings: must be { "m": 20, "min_score": 0.25, "min_n": 20 }`);
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as NonNullable<ReporterHandlesData["prior_settings"]>) : {};
  const num = (v: unknown, d: number, ok: (x: number) => boolean, k: string) => {
    if (v === undefined) return d;
    if (typeof v === "number" && Number.isFinite(v) && ok(v)) return v;
    reject(`prior_settings.${k}: ${String(v)} is not valid`);
    return d;
  };
  const base = new Map<string, number>();
  for (const [k, v] of Object.entries(rates(root.prior_base_rates, "prior_base_rates", reject))) base.set(k.toLowerCase(), v);
  return {
    m: num(s.m, DEFAULT_PRIOR_SETTINGS.m, (x) => x >= 0, "m"),
    minScore: num(s.min_score, DEFAULT_PRIOR_SETTINGS.minScore, rate, "min_score"),
    minN: num(s.min_n, DEFAULT_PRIOR_SETTINGS.minN, (x) => x >= 0, "min_n"),
    base,
  };
}

/**
 * Honorifics the desk types after a name — "ASHOK SIR" (75 files) is the same person as "ASHOK". Dropped
 * so one reporter is not two roster entries.
 */
const HONORIFICS = new Set(["SIR", "MAM", "MADAM", "JI", "JEE"]);

/**
 * The file-name token form: letters, digits and underscores, compared case-insensitively, with a
 * trailing honorific removed. "PK_AGARWAL", "pk agarwal" and "PK-Agarwal" are one key.
 */
export function reporterKey(s: string): string {
  const parts = s
    .normalize("NFC")
    .trim()
    .replace(/[^\w]+/g, "_")
    .toUpperCase()
    .split("_")
    .filter(Boolean);
  while (parts.length > 1 && HONORIFICS.has(parts[parts.length - 1]!)) parts.pop();
  return parts.join("_");
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** Adds one token → reporter, refusing (and recording) a token two different reporters claim. */
function claim(rules: ReporterRules, spelling: string, match: ReporterMatch, problem: (m: string) => void, where: string): boolean {
  const key = reporterKey(spelling);
  if (!key) return false;
  if (rules.conflicts.has(key)) return false;
  const clash = rules.byToken.get(key);
  if (clash && clash.handle.toLowerCase() !== match.handle.toLowerCase()) {
    // Two reporters, one token: neither is tagged on it. The desk has to disambiguate the file names.
    rules.byToken.delete(key);
    rules.conflicts.add(key);
    problem(`${where}: the token "${spelling}" is also @${clash.handle} — tagging neither until the desk disambiguates`);
    return false;
  }
  rules.byToken.set(key, match);
  return true;
}

/**
 * Checks a parsed reporter-handles.json. The root must be `{ entries: [...] }` or this throws and the
 * worker keeps its last good copy. A malformed entry is skipped and reported through `problem`; an
 * unverified entry is left out silently; a token claimed by two reporters is REMOVED and reported.
 */
export function parseReporterHandles(json: unknown, problem: (message: string) => void = () => undefined, check: ReporterPriorCheck = {}): ReporterRules {
  const root = json as Partial<ReporterHandlesData> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.entries)) {
    throw new Error("reporter handles: expected { version, entries: [...] }");
  }
  // The prior and its settings are rejected WHOLE (b6 fix brief P5): a wrong rate or an invented handle is never
  // quietly skipped or defaulted
  const rejects: string[] = [];
  const reject = (m: string) => rejects.push(m);
  const handles = new Set<string>();
  const verifiedHandles = new Set<string>();
  const profiles = new Map<string, ReporterProfile>();
  if (root.ambiguous_tokens !== undefined && (!Array.isArray(root.ambiguous_tokens) || root.ambiguous_tokens.some((t) => typeof t !== "string" || !t.trim()))) {
    reject(`ambiguous_tokens: must be a list of file-name tokens, ["DINESH", ...]`);
  }
  // Ambiguous tokens are conflicts from the start, so no entry can claim them (§5.1: DINESH is Dangi and Kasana)
  const ambiguous = new Set(strings(root.ambiguous_tokens).map(reporterKey).filter(Boolean));
  const rules: ReporterRules = {
    byToken: new Map(), conflicts: new Set(ambiguous), count: 0, handles, verifiedHandles, profiles, ambiguous, prior: parsePriorSettings(root, reject),
  };
  // This file's own handles are part of the directory a prior may name
  for (const raw of root.entries) {
    const h = (raw as Partial<ReporterHandleEntry> | null)?.handle;
    if (typeof h === "string" && HANDLE.test(h.trim())) handles.add(h.trim().replace(/^@/, "").toLowerCase());
  }
  const priorCheck: ReporterPriorCheck = { ...(check.bound && { bound: check.bound }), ...(check.directory && { directory: new Set([...check.directory, ...handles]) }) };

  root.entries.forEach((raw, i) => {
    const e = raw as Partial<ReporterHandleEntry> | null;
    const where = `entries[${i}]`;
    if (!e || typeof e !== "object") return problem(`${where}: not an object`);
    if (typeof e.handle !== "string" || !HANDLE.test(e.handle.trim())) {
      return problem(`${where}: "${String(e.handle)}" is not an X handle`);
    }
    handles.add(e.handle.trim().replace(/^@/, "").toLowerCase());
    if (typeof e.verified !== "boolean") return problem(`${where} (${e.handle}): "verified" must be true or false`);
    if (!e.verified) return;

    const handle = e.handle.trim().replace(/^@/, "");
    verifiedHandles.add(handle.toLowerCase());
    const name = typeof e.name === "string" && e.name.trim() ? e.name.normalize("NFC").trim() : handle;
    const match: ReporterMatch = { handle, name, districts: strings(e.districts) };
    profiles.set(handle.toLowerCase(), parseProfile(e as ReporterHandleEntry, handle, name, `${where} (${e.handle})`, problem, reject, priorCheck));
    let added = 0;
    for (const spelling of strings(e.names_en)) {
      if (ambiguous.has(reporterKey(spelling))) {
        problem(`${where} (${e.handle}): "${spelling}" is in ambiguous_tokens, so it tags nobody`);
        continue;
      }
      if (claim(rules, spelling, match, problem, `${where} (${e.handle})`)) added++;
    }
    // Not an error: the handle is real and stays in the file, it simply cannot be matched from a file
    // name until the desk adds a spelling or an editor's own edit teaches us one.
    if (!added) return problem(`${where} (${e.handle}): no names_en token yet, so this reporter is never tagged from a file name`);
    rules.count++;
  });

  if (rejects.length) throw new DataFileRejected("reporter-handles", rejects);
  return rules;
}

/** A token the desk taught us by hand, from handle_directory (source "reporter") */
export interface LearnedReporterToken {
  handle: string;
  token: string;
  name?: string | null;
  districts?: string[] | null;
}

/**
 * The roster plus the tokens editors taught us.
 *
 * THE FILE IS THE LIST OF REPORTERS; the learned rows only add NAMES for handles it already carries. A
 * handle the file no longer verifies is dropped here, so removing or un-verifying someone in
 * reporter-handles.json really does stop their byline — otherwise a row in the database would keep
 * tagging them with no way to take it back from the file.
 *
 * A learned token never overrides the file either: where the two disagree the same collision rule
 * applies and neither is tagged, because a token that means two people is exactly the case where a guess
 * puts the wrong colleague's name on a post.
 */
export function mergeReporterTokens(rules: ReporterRules, allLearned: readonly LearnedReporterToken[], problem: (message: string) => void = () => undefined): ReporterRules {
  const verified = rules.verifiedHandles;
  const learned = verified ? allLearned.filter((l) => verified.has(l.handle.replace(/^@/, "").toLowerCase())) : allLearned;
  if (!learned.length) return rules;
  const merged: ReporterRules = {
    // The file's profiles, ambiguous tokens and prior settings carry over: a learned token adds a NAME only
    ...(rules.profiles && { profiles: rules.profiles }),
    ...(rules.ambiguous && { ambiguous: rules.ambiguous }),
    ...(rules.prior && { prior: rules.prior }),
    byToken: new Map(rules.byToken),
    conflicts: new Set(rules.conflicts),
    count: rules.count,
    // A handle learned from an editor's own edit joins both sets: it is a reporter handle the desk uses
    // (so the desk-added-handles rule must leave it and its lookalikes alone) and one an editor vouched
    // for by putting it on a post.
    handles: new Set([...(rules.handles ?? []), ...learned.map((l) => l.handle.replace(/^@/, "").toLowerCase())]),
    verifiedHandles: new Set([...(rules.verifiedHandles ?? []), ...learned.map((l) => l.handle.replace(/^@/, "").toLowerCase())]),
  };
  const known = new Set([...merged.byToken.values()].map((m) => m.handle.toLowerCase()));
  for (const row of learned) {
    const handle = row.handle.trim().replace(/^@/, "");
    if (!HANDLE.test(handle)) continue;
    const existing = [...merged.byToken.values()].find((m) => m.handle.toLowerCase() === handle.toLowerCase());
    const match: ReporterMatch = existing ?? {
      handle,
      name: row.name?.trim() || handle,
      districts: strings(row.districts),
    };
    if (claim(merged, row.token, match, problem, `learned token for @${handle}`) && !known.has(handle.toLowerCase())) {
      known.add(handle.toLowerCase());
      merged.count++;
    }
  }
  return merged;
}

// ─── What the file name said about the reporter, for the decision log (reporter-prior brief §2.2) ──────────

/**
 * Every case is logged, the misses most of all: `unknown_token` is how a missing reporter surfaces,
 * `unknown_bureau_code` how the code table gets confirmed.
 */
export const REPORTER_STATUSES = ["matched", "unknown_token", "collision", "bureau_code", "unknown_bureau_code", "no_slot", "no_filename"] as const;
export type ReporterStatus = (typeof REPORTER_STATUSES)[number];

export interface ReporterResolution {
  status: ReporterStatus;
  /** The slot as the file name spelled it (the reporter token, else the code): post_decisions.slot_raw */
  slotRaw: string | null;
  /** The reporter token, upper-cased, matched or not */
  reporterToken: string | null;
  /** The district code: the places file's (districtCode) or a code-shaped token it does not carry (unknownCode) */
  bureauCode: string | null;
  /** The district the code stands for, when known */
  bureauDistrict: string | null;
  /** The matched roster handle, without the @; null unless `status` is "matched" */
  reporterHandle: string | null;
}

/** The FileTags fields resolveReporterStatus reads (stories.file_tags, or fileTags()) */
export interface ReporterSlotTags {
  reporter: string | null;
  districtCode: string | null;
  district: string | null;
  unknownCode?: string | null;
}

/**
 * The reporter status of one breaking file, from the file name ONLY (never the post's text or handles: brief L1).
 * A reporter token decides the status when there is one (matched / collision / unknown_token); otherwise the
 * district code does (bureau_code / unknown_bureau_code); otherwise no_slot. The bureau fields are filled
 * whenever the name carries a code, whatever the status.
 */
export function resolveReporterStatus(fileName: string | null | undefined, tags: ReporterSlotTags | null | undefined, rules: ReporterRules): ReporterResolution {
  const bureauCode = tags?.districtCode ?? tags?.unknownCode ?? null;
  const bureauDistrict = tags?.districtCode ? (tags.district ?? null) : null;
  const base = { reporterToken: null, reporterHandle: null, bureauCode, bureauDistrict };
  if (!fileName || !fileName.trim()) return { ...base, status: "no_filename", slotRaw: null, bureauCode: null, bureauDistrict: null };
  const token = tags?.reporter ? reporterKey(tags.reporter) || null : null;
  if (token) {
    const slot = { ...base, reporterToken: token, slotRaw: tags!.reporter };
    const hit = rules.byToken.get(token);
    if (hit) return { ...slot, status: "matched", reporterHandle: hit.handle };
    if (rules.conflicts.has(token)) return { ...slot, status: "collision" };
    return { ...slot, status: "unknown_token" };
  }
  if (tags?.districtCode) return { ...base, status: "bureau_code", slotRaw: tags.districtCode };
  if (tags?.unknownCode) return { ...base, status: "unknown_bureau_code", slotRaw: tags.unknownCode };
  return { ...base, status: "no_slot", slotRaw: null };
}

export interface ReporterPick {
  match: ReporterMatch | null;
  /** The token we were given but could not place. Log these: it is how the roster gets completed. */
  unmatchedToken: string | null;
  /** The token names more than one reporter (ambiguous_tokens, or two entries claim it): nobody is tagged */
  collision?: string;
}

/**
 * The reporter for a story, from the file name's token. A token the roster does not carry comes back as
 * `unmatchedToken` rather than silently nothing, and tags nobody: a new reporter's name on a file never
 * guesses at a handle.
 */
export function pickReporter(token: string | null | undefined, rules: ReporterRules): ReporterPick {
  if (!token) return { match: null, unmatchedToken: null };
  const key = reporterKey(token);
  if (!key) return { match: null, unmatchedToken: null };
  const hit = rules.byToken.get(key);
  if (hit) return { match: hit, unmatchedToken: null };
  // A token that names more than one reporter is not missing from the list: it is ambiguous, and tags nobody
  if (rules.conflicts.has(key)) return { match: null, unmatchedToken: null, collision: key };
  return { match: null, unmatchedToken: key };
}

/** Whether a reporter's known districts disagree with the story's. A warning for the draft, never a block. */
export function districtMismatch(m: ReporterMatch, district: string | null): boolean {
  if (!district || !m.districts.length) return false;
  // fold() already lower-cases and drops punctuation; only the spaces have to go, so that "SawaiMadhopur"
  // and "Sawai Madhopur" are one district. Stripping everything non-ASCII instead would collapse every
  // Devanagari district name to "" and compare them all equal.
  const k = (s: string) => fold(s).replace(/\s+/g, "");
  // A district carved out in 2023 is still its parent's beat: @jawaharbedam (Bharatpur) filing from Deeg is
  // not a mismatch
  const parent = CARVED_FROM.get(k(district));
  return !m.districts.some((d) => k(d) === k(district) || (parent !== undefined && k(d) === parent));
}

/**
 * The districts formed in 2023 and the district each was (mostly) carved from, folded and unspaced. Reporters
 * of the parent still cover them.
 */
const CARVED_FROM: ReadonlyMap<string, string> = new Map(
  [
    ["Deeg", "Bharatpur"], ["Didwana-Kuchaman", "Nagaur"], ["DidwanaKuchaman", "Nagaur"], ["Beawar", "Ajmer"], ["Balotra", "Barmer"],
    ["Phalodi", "Jodhpur"], ["Salumber", "Udaipur"], ["Salumbar", "Udaipur"], ["Kotputli-Behror", "Jaipur"], ["KotputliBehror", "Jaipur"],
    ["Khairthal-Tijara", "Alwar"], ["KhairthalTijara", "Alwar"],
  ].map(([c, p]) => [fold(c!).replace(/\s+/g, ""), fold(p!).replace(/\s+/g, "")]),
);

/**
 * The one district a reporter's filing can stand for (§2.8 inference), or null: a reporter listed for two or
 * more districts, or for none (a state bureau such as Navin's ACB beat), says nothing about where a story is.
 * Measured 98.5% (670/680) against posts that do carry a district — and still only ever a suggestion.
 */
export function reporterDistrict(m: ReporterMatch | null | undefined): string | null {
  return m && m.districts.length === 1 ? m.districts[0]! : null;
}
