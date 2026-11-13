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
//             when the beat's keywords are in the copy. Reporter identity alone never offers a declared beat.
//
// The reporter is read from the file-name token and nothing else (L1): a handle in the copy cannot select it.

import { DataFileRejected } from "./post-tags";
import type { HandlePick } from "./handles";
import { SOURCES, beatSource, type TagSuggestion } from "./proposals";
import { DEFAULT_PRIOR_SETTINGS, type ReporterProfile, type ReporterRules } from "./reporters";

// ─── beat-handles.json ───────────────────────────────────────────────────────

export interface BeatHandlesData {
  [beat: string]: { keywords: string; handles: string[] } | unknown;
}

export interface Beat {
  key: string;
  pattern: RegExp;
  /** Without the @ */
  handles: string[];
}

export interface BeatRules {
  beats: Map<string, Beat>;
}

export const EMPTY_BEAT_RULES: BeatRules = { beats: new Map() };

/**
 * Beats that would be a second, unguarded road to the CM or the state government. CM mentions go through the
 * office alias (subject-handles.json `offices`), which carries the other-state and former-CM exclusions;
 * @RajGovOfficial has no reliable text cue at all (0 of 19 government-event posts) and comes from the measured
 * prior only (brief §3.3).
 */
const FORBIDDEN_BEATS: Readonly<Record<string, string>> = {
  cm: "CM mentions go through the office alias in subject-handles.json (\"offices\".rajasthan_cm), which carries the other-state and former-CM exclusions",
  "chief-minister": "CM mentions go through the office alias in subject-handles.json (\"offices\".rajasthan_cm)",
  "state-government": "@RajGovOfficial has no text cue (0 of 19 government-event posts); it comes from the measured prior only",
};

const HANDLE = /^@?\w{1,15}$/;

/**
 * Checks beat-handles.json. `directory` is every handle the directory files carry (lower-cased, no @): a handle in
 * none of them fails the whole file (V11 / L8), as does a forbidden beat or an unreadable keyword pattern. Never
 * silently corrected: the worker keeps its last good copy and says why.
 */
export function parseBeatHandles(json: unknown, directory: ReadonlySet<string>): BeatRules {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new DataFileRejected("beat-handles", ['expected { "education": { "keywords": "...", "handles": ["@..."] }, ... }']);
  const problems: string[] = [];
  const beats = new Map<string, Beat>();
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    const forbidden = FORBIDDEN_BEATS[key.toLowerCase()];
    if (forbidden) {
      problems.push(`"${key}": not allowed here — ${forbidden}`);
      continue;
    }
    const b = raw as { keywords?: unknown; handles?: unknown } | null;
    if (!b || typeof b !== "object" || typeof b.keywords !== "string" || !b.keywords.trim() || !Array.isArray(b.handles) || !b.handles.length) {
      problems.push(`"${key}": needs "keywords" (a pattern) and "handles" (a list)`);
      continue;
    }
    let pattern: RegExp;
    try {
      // Whole words only: "बोर्ड" must not fire inside a longer word
      pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${b.keywords.normalize("NFC")})(?![\\p{L}\\p{M}\\p{N}])`, "iu");
    } catch {
      problems.push(`"${key}": "keywords" is not a valid pattern`);
      continue;
    }
    const handles: string[] = [];
    for (const h of b.handles) {
      if (typeof h !== "string" || !HANDLE.test(h.trim())) {
        problems.push(`"${key}": "${String(h)}" is not an X handle`);
        continue;
      }
      const bare = h.trim().replace(/^@/, "");
      if (!directory.has(bare.toLowerCase())) problems.push(`"${key}": @${bare} is in no directory file — add it to one (verified) first; a handle is never invented`);
      else handles.push(bare);
    }
    beats.set(key, { key, pattern, handles });
  }
  if (problems.length) throw new DataFileRejected("beat-handles", problems);
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
  /** Handles a reporter must never bring: every district police, collector and administration handle (§3.5) */
  districtBound: ReadonlySet<string>;
  /**
   * Every handle the directory files carry, lower-cased without the @. When given, a prior handle in none of them is
   * dropped — a handle is never invented (V11, L8). Empty or absent: not checked here (the tests pin the config).
   */
  directory?: ReadonlySet<string>;
}

export interface PriorResult {
  handles: HandlePick[];
  hashtags: TagSuggestion[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const first = (name: string) => name.split(/\s+/)[0] ?? name;

/**
 * The prior's suggestions: measured handles above the threshold, then declared beats whose keywords match, each
 * once, none already taken, none district-bound. Highest smoothed rate first.
 */
export function reporterPrior(input: PriorInput, rules: ReporterRules, beats: BeatRules = EMPTY_BEAT_RULES): PriorResult {
  const out: PriorResult = { handles: [], hashtags: [] };
  const p = input.profile;
  if (!p) return out;
  const s = rules.prior ?? DEFAULT_PRIOR_SETTINGS;
  const seen = new Set(input.taken);
  const known = (h: string) => !input.directory?.size || input.directory.has(h.toLowerCase());
  const ok = (h: string) => !seen.has(h.toLowerCase()) && !input.districtBound.has(h.toLowerCase()) && known(h);

  if (p.prior && p.prior.n >= s.minN) {
    const n = p.prior.n;
    const scored = Object.entries(p.prior.handles)
      .map(([h, r]) => ({ h, r, score: smoothedRate(r, n, s.base.get(h.toLowerCase()) ?? 0, s.m) }))
      .filter((x) => x.score >= s.minScore)
      .sort((a, b) => b.score - a.score);
    for (const { h, r, score } of scored) {
      if (!ok(h)) continue;
      seen.add(h.toLowerCase());
      out.handles.push({
        handle: h, reason: "prior", source: SOURCES.reporterPrior, score: Math.round(score * 100) / 100, n,
        detail: `${first(p.name)} files @${h} stories ${pct(r)} of the time (${n} posts; smoothed ${score.toFixed(2)}, an upper bound)`,
      });
    }
    const tags = Object.entries(p.prior.hashtags)
      .map(([t, r]) => ({ t: `#${t.replace(/^#/, "")}`, r, score: smoothedRate(r, n, s.base.get(`#${t.replace(/^#/, "")}`.toLowerCase()) ?? 0, s.m) }))
      .filter((x) => x.score >= s.minScore && !input.takenTags.has(x.t.toLowerCase()))
      .sort((a, b) => b.score - a.score);
    for (const { t, r, score } of tags) {
      out.hashtags.push({ tag: t, source: SOURCES.reporterPrior, reason: `${first(p.name)} files ${t} stories ${pct(r)} of the time (${n} posts; smoothed ${score.toFixed(2)})`, score: Math.round(score * 100) / 100, n });
    }
  }

  const text = input.text.normalize("NFC");
  for (const key of p.beats) {
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
