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
  verified: boolean;
  /** X's numeric user id. Handles get renamed and recycled; the id is what identifies the account. */
  xUserId?: string;
  source?: string;
  evidence?: number;
  checkedAt?: string;
  note?: string;
}

export interface ReporterHandlesData {
  version: number;
  entries: ReporterHandleEntry[];
}

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
}

export const EMPTY_REPORTER_RULES: ReporterRules = { byToken: new Map(), conflicts: new Set(), count: 0 };

const HANDLE = /^@?\w{1,15}$/;
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
export function parseReporterHandles(json: unknown, problem: (message: string) => void = () => undefined): ReporterRules {
  const root = json as Partial<ReporterHandlesData> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.entries)) {
    throw new Error("reporter handles: expected { version, entries: [...] }");
  }
  const handles = new Set<string>();
  const verifiedHandles = new Set<string>();
  const rules: ReporterRules = { byToken: new Map(), conflicts: new Set(), count: 0, handles, verifiedHandles };

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
    let added = 0;
    for (const spelling of strings(e.names_en)) if (claim(rules, spelling, match, problem, `${where} (${e.handle})`)) added++;
    // Not an error: the handle is real and stays in the file, it simply cannot be matched from a file
    // name until the desk adds a spelling or an editor's own edit teaches us one.
    if (!added) return problem(`${where} (${e.handle}): no names_en token yet, so this reporter is never tagged from a file name`);
    rules.count++;
  });

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

export interface ReporterPick {
  match: ReporterMatch | null;
  /** The token we were given but could not place. Log these: it is how the roster gets completed. */
  unmatchedToken: string | null;
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
  return { match: null, unmatchedToken: key };
}

/** Whether a reporter's known districts disagree with the story's. A warning for the draft, never a block. */
export function districtMismatch(m: ReporterMatch, district: string | null): boolean {
  if (!district || !m.districts.length) return false;
  // fold() already lower-cases and drops punctuation; only the spaces have to go, so that "SawaiMadhopur"
  // and "Sawai Madhopur" are one district. Stripping everything non-ASCII instead would collapse every
  // Devanagari district name to "" and compare them all equal.
  const k = (s: string) => fold(s).replace(/\s+/g, "");
  return !m.districts.some((d) => k(d) === k(district));
}
