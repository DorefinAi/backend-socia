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
import { HANDLE } from "./syntax";

/** One entry of party-handles.json */
export interface PartyHandleEntry {
  handle: string;
  /** What the draft calls it: "BJP Rajasthan". The `party` key below is for the clash rule, not for reading. */
  name?: string;
  party: string;
  /**
   * "state" | "national" | "wing" | "media" ... — the state handle is preferred for a Rajasthan story. A "wing"
   * (NSUI, the youth congress) is never tagged on its own: it is OFFERED when the copy names it literally
   * (pickPartyHandles). No wing-specific rule: @NSUIRajasthan is once in 2,476 posts (b6 fix brief P4).
   */
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
  return preferred(hits, rajasthan);
}

/** The party's own handle among the hits (never a wing), the state one first on a Rajasthan story */
function preferred(hits: readonly PartyRule[], rajasthan: boolean): PartyRule | null {
  const parties = hits.filter((h) => h.scope !== "wing");
  const want = rajasthan ? "state" : "national";
  return parties.find((h) => h.scope === want) ?? parties[0] ?? null;
}

// ─── attack targets (b6 fix brief P4) ────────────────────────────────────────
//
// UNVALIDATED. This rule rests on 6 corpus posts that pair an attack verb with a named party, and the desk is
// inconsistent across them: one tags the attacker only, one tags both, one tags neither, one tags the
// opposite party. It is a cheap guard against the obvious error (tagging the party a story attacks), not a
// measured desk behaviour. Do not build on it, and do not treat it as established, without more evidence.

/** "पर" / "को" / "खिलाफ": the party is the object */
const AT = new Set(["पर", "को", "खिलाफ"].map(fold));
const AGAINST = fold("खिलाफ");
const NE = fold("ने");
/** What is done to it: "पर साधा निशाना", "पर हमला", "पर पलटवार", "पर लगाए आरोप", "के खिलाफ ..." */
const ATTACK = new Set(
  ["निशाना", "हमला", "हमले", "हमलावर", "पलटवार", "तंज", "आरोप", "आरोपों", "प्रहार", "वार", "कटाक्ष", "बरसे", "बरसी", "बरसा", "घेरा", "घेरे", "सवाल"].map(fold),
);

/**
 * The parties the HEADLINE names only as the target of an attack ("भाजपा ने NSUI पर साधा निशाना": congress,
 * through its wing). Every mention has to be a target: "कांग्रेस ने ... कांग्रेस पर" is not.
 */
export function attackTargets(headline: string, rules: PartyRules): Set<string> {
  const t = fold(headline.normalize("NFC")).split(" ").filter(Boolean);
  const seen = new Map<string, boolean>();
  const anyParty = new Set(rules.rules.flatMap((r) => r.tokens));
  for (const r of partyHits(headline, rules)) {
    const at = t.flatMap((w, i) => (r.tokens.includes(w) ? [i] : []));
    for (const i of at) {
      // The object marker within 3 words of the name ("भाजपा सरकार पर", "कांग्रेस के खिलाफ"), with no agent
      // marker or other party in between ("भाजपा ने NSUI पर": the पर is NSUI's), then the attack within 4
      // words of it ("पर लगाए गंभीर आरोप"); "खिलाफ" is an attack by itself
      let j = -1;
      for (let k = i + 1; k < Math.min(t.length, i + 4); k++) {
        if (t[k] === NE || anyParty.has(t[k]!)) break;
        if (AT.has(t[k]!)) {
          j = k;
          break;
        }
      }
      const target = j >= 0 && (t[j] === AGAINST || t.slice(j + 1, j + 5).some((w) => ATTACK.has(w)));
      seen.set(r.party, (seen.get(r.party) ?? true) && target);
    }
  }
  return new Set([...seen].filter(([, target]) => target).map(([party]) => party));
}

export interface PartyHandles {
  /** Tagged on the post: the party its HEADLINE names (not as an attack target), one party only in the copy */
  emit: PartyRule | null;
  /** Offered, never tagged: a party named only in the points, a wing named literally, the headline's party on a clash story, an attacked party */
  suggest: PartyRule[];
}

/**
 * The party handles for political copy, split into what goes on the post and what is offered (b6 fix brief
 * P3, P4). Measured on 2,476 posts: Congress in the headline was tagged 59% of the time and only in the points
 * 44%; BJP 48% and 39%. Points-only tagging is normal desk behaviour, so a points-only match is OFFERED, not
 * blocked; headline presence raises it to the post.
 *   - a party the headline names only as an attack's target is offered, never tagged (UNVALIDATED);
 *   - two parties in the copy: none tagged (the desk takes no side), the headline's non-target one offered;
 *   - a wing (NSUI, youth congress) is offered when the copy names it literally, in Rajasthan; never tagged.
 */
export function pickPartyHandles(headline: string, body: string, rules: PartyRules, rajasthan: boolean): PartyHandles {
  const suggest: PartyRule[] = [];
  if (!rules.count) return { emit: null, suggest };
  const targets = attackTargets(headline, rules);
  const head = partyHits(headline, rules).filter((h) => !targets.has(h.party));
  const all = partyHits(`${headline}\n${body}`, rules).filter((h) => !targets.has(h.party));
  const parties = new Set(partyHits(`${headline}\n${body}`, rules).map((h) => h.party));
  let emit: PartyRule | null = null;
  if (parties.size === 1) {
    const own = preferred(head, rajasthan) && preferred(all, rajasthan);
    if (own) emit = own;
    else {
      const offered = preferred(all, rajasthan);
      if (offered) suggest.push(offered);
    }
  } else {
    for (const party of new Set(head.map((h) => h.party))) {
      const offered = preferred(all.filter((h) => h.party === party), rajasthan);
      if (offered) suggest.push(offered);
    }
  }
  if (rajasthan) for (const w of all.filter((h) => h.scope === "wing")) suggest.push(w);
  // The target of an attack is OFFERED, never tagged: "भाजपा प्रत्याशी पर हमला" is the BJP's story too, and the
  // desk tags it either way (UNVALIDATED, see above). Its wing is not offered on that ground.
  const hitByParty = partyHits(`${headline}
${body}`, rules);
  for (const party of targets) {
    const offered = preferred(hitByParty.filter((h) => h.party === party), rajasthan);
    if (offered) suggest.push(offered);
  }
  return { emit, suggest: suggest.filter((s, i) => s.handle !== emit?.handle && suggest.findIndex((x) => x.handle === s.handle) === i) };
}
