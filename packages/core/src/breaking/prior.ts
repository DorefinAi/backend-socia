// The reporter routing prior (reporter-prior brief §3): who filed the story, from the FILE NAME, makes some handles
// likely. Suggestions only — never a tag on the post, never a district, never a police, collector or administration
// handle — added after every other rule has finished, so nothing they produced moves (brief §3.5, L7).
//
// TWO SOURCES, kept apart because they mean different things:
//   measured  reporter-handles.json `prior`: the share of the reporter's posts that carried a handle, SMOOTHED
//             towards the share across all posts, so 3 posts are not evidence: (k + m·base) / (n + m), m = 20.
//             Offered when the smoothed rate is ≥ 0.25 and the reporter has ≥ 20 posts. The seed values were
//             measured on posts where the desk tagged the reporter, mostly political and government copy: an
//             UPPER BOUND (L2) until the decision log replaces them.
//   declared  beat-handles.json: a beat the X team told us a reporter covers ("education") adds its handles ONLY
//             when the reporter's beats_source is "desk" AND the beat's keywords are in the copy. Reporter identity
//             alone never offers a declared beat; an "observed" beat label offers nothing.
//
// The reporter is read from the file-name token and nothing else (L1): a handle in the copy cannot select it.

import { DataFileRejected } from "./post-tags";
import type { PriorHandlePick, RuleHandlePick } from "./handles";
import { PROPOSAL_SOURCES, beatSource, type TagSuggestion } from "./proposals";
import { DEFAULT_PRIOR_SETTINGS, type ReporterProfile, type ReporterRules } from "./reporters";
import { HANDLE, plainText, wholeWord } from "./syntax";

// ─── beat-handles.json ───────────────────────────────────────────────────────

export interface DeclaredBeat {
  /** The beat's key, case-folded: "education" */
  key: string;
  pattern: RegExp;
  /** Without the @ */
  handles: readonly string[];
}

export interface BeatRules {
  /** By case-folded key */
  beats: ReadonlyMap<string, DeclaredBeat>;
}

export const EMPTY_BEAT_RULES: BeatRules = Object.freeze({ beats: new Map<string, DeclaredBeat>() });

/** A beat key as compared for the forbidden list: lower-case, no spaces, hyphens or underscores ("State_Government" → "stategovernment") */
const beatName = (key: string): string => key.toLowerCase().replace(/[\s\-_]+/g, "");

const CM_BEAT = "CM mentions go through the office alias in subject-handles.json (\"offices\".rajasthan_cm), which carries the other-state and former-CM exclusions";
const GOVT_BEAT = "@RajGovOfficial has no text cue (0 of 19 government-event posts); it comes from the measured prior only";
/**
 * Beats that would be a second, unguarded road to the CM or the state government, by beatName. CM mentions go
 * through the office alias (subject-handles.json `offices`), which carries the other-state and former-CM
 * exclusions; @RajGovOfficial has no reliable text cue at all (0 of 19 government-event posts) and comes from the
 * measured prior only (brief §3.3). A beat under another name that lists their handles is caught by STATE_HANDLES.
 */
const FORBIDDEN_BEATS: ReadonlyMap<string, string> = new Map([
  ["cm", CM_BEAT], ["cmo", CM_BEAT], ["chiefminister", CM_BEAT], ["chiefministersoffice", CM_BEAT], ["मुख्यमंत्री", CM_BEAT],
  ["stategovernment", GOVT_BEAT], ["stategovt", GOVT_BEAT], ["government", GOVT_BEAT], ["govt", GOVT_BEAT],
]);

/**
 * Handles no beat may offer, whatever the beat is called: the CM's office-alias handles and the state government
 * (lower-case, no @). They come from the office alias and the measured prior only. The caller adds the ones its
 * files carry (BeatCheckOptions.stateHandles).
 */
const STATE_HANDLES: ReadonlySet<string> = new Set(["bhajanlalbjp", "rajcmo", "rajgovofficial"]);

export interface BeatCheckOptions {
  /** Every district police, collector and state police handle, VERIFIED OR NOT (HandleRules.bound): never a beat's */
  bound?: ReadonlySet<string>;
  /** More handles no beat may carry: the office aliases' and the state government's, lower-cased without the @ */
  stateHandles?: ReadonlySet<string>;
  /** The reporter roster, to warn about a desk-declared beat label this file has no key for */
  reporters?: ReporterRules;
  /** Warnings that do not reject the file */
  problem?: (message: string) => void;
}

/**
 * Checks beat-handles.json. `directory` is every handle the directory files carry (lower-cased, no @): a handle in
 * none of them fails the whole file (V11 / L8), as does a forbidden beat, a beat carrying a CM, state-government,
 * police or collector handle, two keys that differ only in case, and a keyword pattern that is unreadable or
 * matches empty text. Never silently corrected: the worker keeps its last good copy and says why.
 */
export function parseBeatHandles(json: unknown, directory: ReadonlySet<string>, opts: BeatCheckOptions = {}): BeatRules {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new DataFileRejected("beat-handles", ['expected { "education": { "keywords": "...", "handles": ["@..."] }, ... }']);
  const problems: string[] = [];
  const beats = new Map<string, DeclaredBeat>();
  const state = new Set([...STATE_HANDLES, ...(opts.stateHandles ?? [])].map((h) => h.replace(/^@/, "").toLowerCase()));
  for (const [rawKey, raw] of Object.entries(json as Record<string, unknown>)) {
    if (rawKey.startsWith("_")) continue;
    const key = rawKey.trim().toLowerCase();
    const forbidden = FORBIDDEN_BEATS.get(beatName(key));
    if (forbidden !== undefined) {
      problems.push(`"${rawKey}": not allowed here — ${forbidden}`);
      continue;
    }
    if (beats.has(key)) {
      problems.push(`"${rawKey}": the beat "${key}" is listed twice (keys are compared without case)`);
      continue;
    }
    const b = raw as { keywords?: unknown; handles?: unknown } | null;
    if (!b || typeof b !== "object" || typeof b.keywords !== "string" || !b.keywords.trim() || !Array.isArray(b.handles) || !b.handles.length) {
      problems.push(`"${rawKey}": needs "keywords" (a pattern) and "handles" (a list)`);
      continue;
    }
    const keywords = b.keywords.normalize("NFC");
    let pattern: RegExp;
    try {
      // A pattern that matches empty text ("स्कूल|") would fire on every story
      if (new RegExp(keywords, "u").test("")) {
        problems.push(`"${rawKey}": "keywords" matches empty text, so it would fire on every story`);
        continue;
      }
      // Whole words only: "बोर्ड" must not fire inside a longer word
      pattern = wholeWord(keywords, "iu");
    } catch {
      problems.push(`"${rawKey}": "keywords" is not a valid pattern`);
      continue;
    }
    const handles: string[] = [];
    for (const h of b.handles) {
      if (typeof h !== "string" || !HANDLE.test(h.trim())) {
        problems.push(`"${rawKey}": "${String(h)}" is not an X handle`);
        continue;
      }
      const bare = h.trim().replace(/^@/, "");
      const lc = bare.toLowerCase();
      if (state.has(lc)) problems.push(`"${rawKey}": @${bare} is a CM or state-government handle — those come from the office alias and the measured prior only`);
      else if (opts.bound?.has(lc)) problems.push(`"${rawKey}": @${bare} is a district police, collector or state police handle — a reporter never brings one (brief §3.5)`);
      else if (!directory.has(lc)) problems.push(`"${rawKey}": @${bare} is in no directory file — add it to one (verified) first; a handle is never invented`);
      else handles.push(bare);
    }
    beats.set(key, { key, pattern, handles: Object.freeze(handles) });
  }
  if (problems.length) throw new DataFileRejected("beat-handles", problems);
  // A beat the desk declared for a reporter that this file has no key for offers nothing: say so, once per load
  for (const p of opts.reporters?.profiles?.values() ?? []) {
    if (p.beatsSource !== "desk") continue;
    for (const label of p.beats) {
      if (!beats.has(label.trim().toLowerCase())) opts.problem?.(`@${p.handle} declares the beat "${label}", which beat-handles.json has no key for: display only, it offers nothing`);
    }
  }
  return { beats };
}

// ─── the prior ───────────────────────────────────────────────────────────────

/** (k + m·base) / (n + m), with k = rate·n */
export const smoothedRate = (rate: number, n: number, base: number, m: number): number => (rate * n + m * base) / (n + m);

export interface PriorInput {
  /** The profile of the reporter the FILE NAME names (resolveReporterStatus / pickReporter), or null */
  profile: ReporterProfile | null;
  /** The copy the declared beats' keywords are read against: headline and points */
  text: string;
  /** Handles already emitted or offered by the other rules, lower-cased without the @: never offered again */
  taken: ReadonlySet<string>;
  /** Hashtags already emitted or offered, lower-cased with the # */
  takenTags: ReadonlySet<string>;
  /** Handles a reporter must never bring: every district police, collector and state police handle, verified or not (§3.5) */
  districtBound: ReadonlySet<string>;
  /**
   * Every handle the directory files carry, lower-cased without the @. A prior handle in none of them is dropped —
   * a handle is never invented (V11, L8). Empty or absent: the check cannot be made, so NO handle is offered (fail
   * closed) and `warnings` says why.
   */
  directory: ReadonlySet<string> | null | undefined;
}

export interface PriorResult {
  handles: (PriorHandlePick | RuleHandlePick)[];
  hashtags: TagSuggestion[];
  /** Why something was held back (an empty directory) */
  warnings: string[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const first = (name: string) => name.split(/\s+/)[0] ?? name;
/** Highest score first; equal scores by name, so the order never depends on the file's key order */
const byScore = (a: { score: number; key: string }, b: { score: number; key: string }): number =>
  b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The prior's suggestions: measured handles above the threshold, then declared beats whose keywords match, each
 * once, none already taken, none district-bound, none outside the directory. Highest smoothed rate first.
 */
export function reporterPrior(input: PriorInput, rules: ReporterRules, beats: BeatRules = EMPTY_BEAT_RULES): PriorResult {
  const out: PriorResult = { handles: [], hashtags: [], warnings: [] };
  const p = input.profile;
  if (!p) return out;
  const s = rules.prior ?? DEFAULT_PRIOR_SETTINGS;
  const seen = new Set(input.taken);
  const directory = input.directory && input.directory.size > 0 ? input.directory : null;
  if (!directory) out.warnings.push("the handle directory is empty or missing, so the reporter prior offers no handles (fail closed)");
  const ok = (h: string): boolean => {
    const lc = h.toLowerCase();
    return !!directory && directory.has(lc) && !seen.has(lc) && !input.districtBound.has(lc);
  };

  if (p.prior && p.prior.n >= s.minN) {
    const n = p.prior.n;
    const scored = Object.entries(p.prior.handles)
      .map(([h, r]) => ({ key: h, r, score: smoothedRate(r, n, s.base.get(h.toLowerCase()) ?? 0, s.m) }))
      .filter((x) => x.score >= s.minScore)
      .sort(byScore);
    for (const { key: h, r, score } of scored) {
      if (!ok(h)) continue;
      seen.add(h.toLowerCase());
      out.handles.push({
        handle: h, reason: "prior", source: PROPOSAL_SOURCES.reporterPrior, score: Math.round(score * 100) / 100, n,
        detail: `${first(p.name)} files @${h} stories ${pct(r)} of the time (${n} posts; smoothed ${score.toFixed(2)}, an upper bound)`,
      });
    }
    const tags = Object.entries(p.prior.hashtags)
      .map(([t, r]) => {
        const key = `#${t.replace(/^#/, "")}`;
        return { key, r, score: smoothedRate(r, n, s.base.get(key.toLowerCase()) ?? 0, s.m) };
      })
      .filter((x) => x.score >= s.minScore && !input.takenTags.has(x.key.toLowerCase()))
      .sort(byScore);
    for (const { key: t, r, score } of tags) {
      out.hashtags.push({
        tag: t, source: PROPOSAL_SOURCES.reporterPrior, score: Math.round(score * 100) / 100, n,
        reason: `${first(p.name)} files ${t} stories ${pct(r)} of the time (${n} posts; smoothed ${score.toFixed(2)})`,
      });
    }
  }

  // Declared beats: only what the X team TOLD us (beats_source "desk"); an observed or unstated label offers nothing
  if (p.beatsSource !== "desk") return out;
  const text = plainText(input.text);
  for (const label of p.beats) {
    const key = label.trim().toLowerCase();
    const beat = beats.beats.get(key);
    if (!beat || !beat.pattern.test(text)) continue;
    for (const h of beat.handles) {
      if (!ok(h)) continue;
      seen.add(h.toLowerCase());
      out.handles.push({ handle: h, reason: "beat", source: beatSource(key), detail: `declared beat: ${key} (${first(p.name)}, told to us by the desk), and the copy matches it` });
    }
  }
  return out;
}
