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
   * deputy, another state's CM by name. Matched without case ("Former", "FORMER").
   */
  exclude_same_sentence?: string[];
  /**
   * Names of shared lists in the file's top-level `office_exclusion_lists` ("other_states"), added to
   * exclude_same_sentence: the CM and the Chief Secretary read one list of other states, so they cannot drift apart.
   */
  exclude_same_sentence_lists?: string[];
  /**
   * Short codes that are also other words ("MP": a state and a Member of Parliament; "Ex" in "ex-servicemen"): they
   * make it another office ONLY right beside the alias ("MP CM", "MP के मुख्यमंत्री", "MP-CM", "Ex CM", "Ex-CS", "CM of MP"),
   * matched with case as written.
   */
  exclude_next_to_alias?: string[];
  /** The line shown with the offered handle; default "CM mentioned without a name" */
  detail?: string;
}

export interface Office {
  key: string;
  /** Matches any alias as a whole word ("CM" never inside CMO, CMHO, ACM; "मुख्यमंत्री" never inside "उपमुख्यमंत्री") */
  alias: RegExp;
  /** Any of exclude_same_sentence anywhere in the sentence, without case */
  exclude: RegExp | null;
  /** exclude_next_to_alias right beside the alias */
  excludeNear: RegExp | null;
  /** Without the @ */
  handles: string[];
  /** The stable rule id: "office_alias.rajasthan_cm" */
  source: OfficeRuleId;
  detail?: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (list: string[]) => list.map((w) => esc(w.normalize("NFC").trim())).filter(Boolean).join("|");
/**
 * A whole word in Hindi or English: no letter, mark or digit on either side. The ALIAS is matched WITH case on
 * purpose: "CM" only, since a lower-case "cm" is centimetres; the exclusions pass "iu".
 */
const whole = (alt: string, flags = "u") => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alt})(?![\\p{L}\\p{M}\\p{N}])`, flags);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/**
 * The `offices` block of subject-handles.json, with its shared `office_exclusion_lists`. Every problem is returned
 * (the caller rejects the whole file): an office with no alias, a handle that is not in `directory` (handles of this
 * file, lower-cased, no @), a shared list that is not a list of words, an office naming a list that does not exist.
 */
export function parseOffices(json: unknown, directory: ReadonlySet<string>, sharedLists?: unknown): { offices: Office[]; problems: string[] } {
  const problems: string[] = [];
  const offices: Office[] = [];
  const lists = new Map<string, string[]>();
  if (sharedLists !== undefined) {
    if (!sharedLists || typeof sharedLists !== "object" || Array.isArray(sharedLists)) problems.push('"office_exclusion_lists" must be { "other_states": ["...", ...] }');
    else {
      for (const [name, v] of Object.entries(sharedLists as Record<string, unknown>)) {
        if (name.startsWith("_")) continue;
        if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x.trim())) problems.push(`office_exclusion_lists.${name}: must be a list of words`);
        else lists.set(name, v as string[]);
      }
    }
  }
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
    const alias = words(aliases);
    const shared: string[] = [];
    if (o.exclude_same_sentence_lists !== undefined && !Array.isArray(o.exclude_same_sentence_lists)) problems.push(`offices.${key}: "exclude_same_sentence_lists" must be a list of names`);
    for (const name of strings(o.exclude_same_sentence_lists)) {
      const l = lists.get(name);
      if (l) shared.push(...l);
      else problems.push(`offices.${key}: "${name}" is not a list in office_exclusion_lists`);
    }
    const ex = words([...strings(o.exclude_same_sentence), ...shared]);
    const near = words(strings(o.exclude_next_to_alias));
    // "MP CM", "MP के मुख्यमंत्री", "CM of MP": the code beside the alias, at most a postposition between them
    // A hyphen or slash may join them too: "MP-CM", "MP/CM", "Ex-CS"
    const excludeNear = near ? whole(`(?:${near})\\s*(?:[-–/]\\s*)?(?:(?:के|की|का)\\s+)?(?:${alias})|(?:${alias})\\s+of\\s+(?:${near})`) : null;
    offices.push({
      key,
      alias: whole(alias),
      exclude: ex ? whole(ex, "iu") : null,
      excludeNear,
      handles,
      source: `office_alias.${key}`,
      ...(typeof o.detail === "string" && o.detail.trim() && { detail: o.detail.trim() }),
    });
  }
  return { offices, problems };
}

/**
 * What a full stop closes when it does NOT end a sentence: an abbreviation ("डॉ.", "Dr.", "श्री.") or a single
 * Latin initial ("A. K. Sharma"). "मुख्यमंत्री डॉ. मोहन यादव ने" is one sentence, so its exclusion still applies.
 */
const ABBREVIATION = /(?:^|[\s(])(?:डॉ|श्री|श्रीमती|सुश्री|प्रो|स्व|Dr|Mr|Mrs|Ms|Shri|Smt|Prof|Sh|St|Jr|Sr|\p{Lu})$/u;

/** Sentences: a danda, ! ? | or a line break ends one, and so does a full stop that closes no abbreviation */
function sentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const part of text.normalize("NFC").split(/([।॥|!?\n]+|\.(?=\s|$))/u)) {
    if (part === ".") {
      if (ABBREVIATION.test(cur)) {
        cur += part;
        continue;
      }
      out.push(cur);
      cur = "";
    } else if (/^[।॥|!?\n]+$/u.test(part)) {
      out.push(cur);
      cur = "";
    } else cur += part;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether the copy names the office, unqualified, in at least one sentence: "CM ने भी स्वयं दी आहुतियां" yes;
 * "पूर्व मुख्यमंत्री अशोक गहलोत", "दिल्ली की मुख्यमंत्री रेखा गुप्ता", "CMHO ने जांच के आदेश दिए", "MP के CM" no.
 */
export function namesOffice(office: Office, text: string): boolean {
  return sentences(text).some((s) => office.alias.test(s) && !(office.exclude?.test(s) ?? false) && !(office.excludeNear?.test(s) ?? false));
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
      out.push({ handle: h, reason: "office", source: o.key === "rajasthan_cm" ? PROPOSAL_SOURCES.officeCm : o.source, detail: o.detail ?? "CM mentioned without a name" });
    }
  }
  return out;
}
