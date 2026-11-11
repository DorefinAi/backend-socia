// Party handles — the tag the previous logic threw away.
//
// The old guard was a single regex (PARTY in handles.ts): if the copy mentioned a party or an election,
// the post tagged NO institution at all. Measured against 1,002 published posts that guard is wrong in
// both directions at once:
//
//   @BJP4Rajasthan 42 posts    @INCRajasthan 39    @INCIndia 11    @BJP4India 7
//
// — 99 party tags in two days, all of which the guard would have dropped. Meanwhile the thing the guard
// was protecting against is real and must be kept: in the same windows NO post tagged a district police
// handle or a collector alongside a party, bar two that read as desk slips.
//
// So the rule is not "political copy tags nobody", it is "political copy tags politicians and parties,
// never the police or the administration". That is what `handles.ts` now encodes.
//
// WHAT STILL TAGS NOBODY: election *machinery* — repolling orders, polling-duty rosters, a village
// boycotting the vote — and bare result bulletins. Those are in storyclass.ts and classify as `soft`. A
// leader's own post still tags nobody at all.

import { fold } from "../fold";

/** One entry of party-handles.json */
export interface PartyHandleEntry {
  handle: string;
  /** What the draft calls it: "BJP Rajasthan". The `party` key below is for the clash rule, not for reading. */
  name?: string;
  party: string;
  /** "state" | "national" | "youth" — the state handle is preferred for a Rajasthan story */
  scope?: string;
  keywords_hi?: string[];
  keywords_en?: string[];
  verified: boolean;
  source?: string;
  evidence?: number;
  xUserId?: string;
  note?: string;
}

export interface PartyHandlesData {
  version: number;
  entries: PartyHandleEntry[];
}

export interface PartyRule {
  handle: string;
  /** Shown on the draft beside the suggested handle */
  name: string;
  party: string;
  scope: string;
  /**
   * Folded one-word keywords, matched as whole TOKENS. Never as substrings: fold() lower-cases Latin, so
   * a substring rule for "INC" fires on "since", "principal" and "incident", and one for "BJP" on any
   * handle containing it. Every false party tag costs the leader their slot.
   */
  tokens: string[];
  /** Folded multi-word keywords ("भारतीय जनता पार्टी"), matched as phrases */
  phrases: string[];
}

export interface PartyRules {
  rules: PartyRule[];
  count: number;
  /** Every handle in the file, verified or not, lower-cased without the @ (the desk-handles guard) */
  handles?: ReadonlySet<string>;
}

export const EMPTY_PARTY_RULES: PartyRules = { rules: [], count: 0 };

const HANDLE = /^@?\w{1,15}$/;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** Checks a parsed party-handles.json. Throws on a malformed root; skips and reports a bad entry. */
export function parsePartyHandles(json: unknown, problem: (message: string) => void = () => undefined): PartyRules {
  const root = json as Partial<PartyHandlesData> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.entries)) {
    throw new Error("party handles: expected { version, entries: [...] }");
  }
  const rules: PartyRule[] = [];
  const handles = new Set<string>();
  root.entries.forEach((raw, i) => {
    const e = raw as Partial<PartyHandleEntry> | null;
    const where = `entries[${i}]`;
    if (!e || typeof e !== "object") return problem(`${where}: not an object`);
    if (typeof e.handle !== "string" || !HANDLE.test(e.handle.trim())) {
      return problem(`${where}: "${String(e.handle)}" is not an X handle`);
    }
    handles.add(e.handle.trim().replace(/^@/, "").toLowerCase());
    if (typeof e.verified !== "boolean") return problem(`${where} (${e.handle}): "verified" must be true or false`);
    if (!e.verified) return;
    const keys = [...strings(e.keywords_hi), ...strings(e.keywords_en)].map(fold).filter(Boolean);
    if (!keys.length) return problem(`${where} (${e.handle}): no keywords to match on`);
    rules.push({
      handle: e.handle.trim().replace(/^@/, ""),
      name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : String(e.party ?? "other"),
      party: String(e.party ?? "other"),
      scope: String(e.scope ?? "state"),
      tokens: keys.filter((k) => !k.includes(" ")),
      phrases: keys.filter((k) => k.includes(" ")),
    });
  });
  return { rules, count: rules.length, handles };
}

/** Every party rule the text names */
function partyHits(text: string, rules: PartyRules): PartyRule[] {
  if (!rules.count) return [];
  const f = fold(text.normalize("NFC"));
  const words = new Set(f.split(" ").filter(Boolean));
  return rules.rules.filter((r) => r.tokens.some((k) => words.has(k)) || r.phrases.some((p) => f.includes(p)));
}

/**
 * Whether the text names any party at all — the political half of the `namedPolitical` hint that
 * storyclass.ts needs, and true even for a clash story naming two parties (which tags neither).
 */
export function namesAnyParty(text: string, rules: PartyRules): boolean {
  return partyHits(text, rules).length > 0;
}

/**
 * The party handle for a story, or null. Prefers the state handle over the national one on a Rajasthan
 * story, because that is what the desk does — @INCRajasthan 39 uses against @INCIndia 11, the national
 * handles appearing almost only on Delhi-datelined posts.
 */
export function pickParty(text: string, rules: PartyRules, rajasthan: boolean): PartyRule | null {
  const hits = partyHits(text, rules);
  if (!hits.length) return null;
  // Both parties named (a clash story, "कांग्रेस ने भाजपा पर साधा निशाना") — tag neither. The desk does not
  // pick a side on an attack story, and tagging both burns the slot the leader should have.
  if (new Set(hits.map((h) => h.party)).size > 1) return null;
  const want = rajasthan ? "state" : "national";
  return hits.find((h) => h.scope === want) ?? hits[0] ?? null;
}
