// An office named without its holder: "CM ने भी स्वयं दी आहुतियां" (reporter-prior brief §6).
//
// Resolved through the OFFICE, not the person, so it survives a change of officeholder: subject-handles.json
// `offices.rajasthan_cm` lists the aliases and the handles. OFFERED ONLY, never tagged: in 2,476 published posts a
// "CM / सीएम / मुख्यमंत्री" with no name occurred 66 times, the desk tagged the CM on 0 of them, and 26 of the 66
// were another state's CM or a former one. A named CM ("मुख्यमंत्री भजनलाल शर्मा") is the subject rules' match,
// and this adds nothing beside it.

import type { HandlePick } from "./handles";
import { PROPOSAL_SOURCES, type OfficeRuleId } from "./proposals";
import { HANDLE } from "./syntax";

export interface OfficeData {
  aliases_hi?: string[];
  aliases_en?: string[];
  handles?: string[];
  holder_since?: string;
  /**
   * Words that, in the SAME SENTENCE as the alias, make it another office: another state, a former holder, a
   * deputy, another state's CM by name.
   */
  exclude_same_sentence?: string[];
}

export interface Office {
  key: string;
  /** Matches any alias as a whole word ("CM" never inside CMO, CMHO, ACM; "मुख्यमंत्री" never inside "उपमुख्यमंत्री") */
  alias: RegExp;
  exclude: RegExp | null;
  /** Without the @ */
  handles: string[];
  /** The stable rule id: "office_alias.rajasthan_cm" */
  source: OfficeRuleId;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (list: string[]) => list.map((w) => esc(w.normalize("NFC").trim())).filter(Boolean).join("|");
/** A whole word in Hindi or English: no letter, mark or digit on either side */
const whole = (alt: string) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alt})(?![\\p{L}\\p{M}\\p{N}])`, "u");

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/**
 * The `offices` block of subject-handles.json. Every problem is returned (the caller rejects the whole file): an
 * office with no alias, a handle that is not in `directory` (handles of this file, lower-cased, no @).
 */
export function parseOffices(json: unknown, directory: ReadonlySet<string>): { offices: Office[]; problems: string[] } {
  const problems: string[] = [];
  const offices: Office[] = [];
  if (json === undefined) return { offices, problems };
  if (!json || typeof json !== "object" || Array.isArray(json)) return { offices, problems: ['"offices" must be { "rajasthan_cm": { ... } }'] };
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    const o = raw as OfficeData | null;
    if (!o || typeof o !== "object") {
      problems.push(`offices.${key}: not an object`);
      continue;
    }
    const aliases = [...strings(o.aliases_hi), ...strings(o.aliases_en)];
    if (!aliases.length) problems.push(`offices.${key}: no aliases`);
    const handles: string[] = [];
    for (const h of strings(o.handles)) {
      if (!HANDLE.test(h.trim())) problems.push(`offices.${key}: "${h}" is not an X handle`);
      else if (!directory.has(h.trim().replace(/^@/, "").toLowerCase())) problems.push(`offices.${key}: ${h} is not an entry of this file — a handle is never invented`);
      else handles.push(h.trim().replace(/^@/, ""));
    }
    if (!handles.length) problems.push(`offices.${key}: no handles`);
    if (!aliases.length || !handles.length) continue;
    const ex = strings(o.exclude_same_sentence);
    offices.push({ key, alias: whole(words(aliases)), exclude: ex.length ? whole(words(ex)) : null, handles, source: `office_alias.${key}` });
  }
  return { offices, problems };
}

/** Sentences: a danda, a full stop, ! ? | or a line break ends one */
const sentences = (text: string): string[] => text.normalize("NFC").split(/[।॥|!?\n]+|\.(?=\s|$)/u).map((s) => s.trim()).filter(Boolean);

/**
 * Whether the copy names the office, unqualified, in at least one sentence: "CM ने भी स्वयं दी आहुतियां" yes;
 * "पूर्व मुख्यमंत्री अशोक गहलोत", "दिल्ली की मुख्यमंत्री रेखा गुप्ता", "CMHO ने जांच के आदेश दिए" no.
 */
export function namesOffice(office: Office, text: string): boolean {
  return sentences(text).some((s) => office.alias.test(s) && !(office.exclude?.test(s) ?? false));
}

/**
 * The offices' handles to offer: on Rajasthan copy that names the office unqualified, minus any handle already on
 * the post or offered. When the copy also names the holder — or the other rules already chose one of the office's
 * handles — the office adds nothing at all (§6.4: no duplicate beside the name match).
 */
export function officeSuggestions(offices: readonly Office[], text: string, taken: ReadonlySet<string>, namesHolder: (office: Office) => boolean): HandlePick[] {
  const out: HandlePick[] = [];
  for (const o of offices) {
    if (!namesOffice(o, text)) continue;
    if (namesHolder(o) || o.handles.some((h) => taken.has(h.toLowerCase()))) continue;
    for (const h of o.handles) {
      if (taken.has(h.toLowerCase()) || out.some((x) => x.handle.toLowerCase() === h.toLowerCase())) continue;
      out.push({ handle: h, reason: "office", source: o.key === "rajasthan_cm" ? PROPOSAL_SOURCES.officeCm : o.source, detail: "CM mentioned without a name" });
    }
  }
  return out;
}
