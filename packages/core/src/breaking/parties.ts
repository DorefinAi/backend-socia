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
import { addHandleType, handleTypeProblem, isHandleType, type HandleType } from "./handle-types";

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
   * An "mla" (a member's own handle) is only ever OFFERED, verified or not, and is not the party (pickMlaHandles).
   */
  scope?: string;
  /**
   * institution / person / district / police (handle-types.ts): a party or wing is "institution", an MLA "person".
   * `unknown` as read from the file (R6, 15 Nov 2026): it is a HandleType only once isHandleType has checked it.
   */
  handle_type: unknown;
  keywords_hi?: string[];
  keywords_en?: string[];
  verified: boolean;
  source?: string;
  evidence?: number;
  xUserId?: string;
  note?: string;
  /**
   * Changes #3 §2.1 (party_of_leader): the party's leaders. When one of these handles is on the draft (emitted or
   * offered), or one of `leader_names` is in the copy, and none of the party's own state or national handles is
   * already there, this entry's handle is OFFERED (never tagged) with `leader_reason`. It goes first among the
   * suggestions when the filing reporter is one of `leader_first_for_reporters`. Optional; a malformed block is
   * ignored and reported, the entry itself still loads.
   */
  leaders?: string[];
  leader_names?: string[];
  leader_first_for_reporters?: string[];
  leader_reason?: string;
  /**
   * The party's hashtag, without the # ("BJP", "Congress"). Put on the post beside the party's handle on an election
   * story (owner, 20 Nov 2026). Only read on a "state" or "national" entry.
   */
  hashtag?: string;
}

/** A party offered because one of its leaders is on the draft (Changes #3 §2.1) */
export interface LeaderRule {
  /** The party handle offered, without the @ */
  handle: string;
  name: string;
  party: string;
  /** The leaders' handles, lower-cased without the @ */
  leaders: ReadonlySet<string>;
  /** Folded leader names matched in the copy (Sonia Gandhi has no handle the desk uses): tokens as whole words, phrases as phrases */
  nameTokens: string[];
  namePhrases: string[];
  /** Reporters (lower-cased handles without the @) for whom the offer goes first */
  firstFor: ReadonlySet<string>;
  /** The line the desk sees */
  reason: string;
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
  /** The party's hashtag without the # (PartyHandleEntry.hashtag), or none */
  hashtag?: string;
}

export interface PartyRules {
  /** The party's own handles (every scope but "mla"): the clash rule, the political hint and the post's party tag */
  rules: PartyRule[];
  count: number;
  /**
   * scope "mla": a member's own handle, OFFERED when the copy names them and never tagged (user decision,
   * 13 Nov 2026). Kept out of `rules` on purpose, so naming an MLA neither counts as naming the party (the
   * clash rule, the political hint that keeps the police and the collector off) nor tags anything. An
   * unverified MLA entry is offered too: an unticked suggestion is the desk's check.
   */
  mla?: PartyRule[];
  /** Every handle in the file, verified or not, lower-cased without the @ (the desk-handles guard) */
  handles?: ReadonlySet<string>;
  /** Each entry's handle_type, lower-cased handle without the @; a rejected entry has none */
  types?: ReadonlyMap<string, HandleType>;
  /** Changes #3 §2.1: parties offered when a leader of theirs is on the draft (verified state or national entries only) */
  leaderRules?: LeaderRule[];
}

export const EMPTY_PARTY_RULES: PartyRules = { rules: [], count: 0 };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/**
 * Every scope the file may carry. Anything else rejects its entry (M1): an unknown scope used to fall through to the
 * party's own rules, so a typo such as "MLA " or "mla_" on a member's entry would have put that member on the post.
 */
export const PARTY_SCOPES = ["state", "national", "wing", "youth", "media", "mla"] as const;
export type PartyScope = (typeof PARTY_SCOPES)[number];
const SCOPES: ReadonlySet<string> = new Set(PARTY_SCOPES);

/** A keyword list that is present must be an array of strings; absent is fine (the other language may carry them) */
const badKeywords = (v: unknown): boolean => v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"));

/**
 * Checks a parsed party-handles.json. Throws on a malformed root; a bad or missing field rejects THAT entry only,
 * reported through `problem` with the entry's index and handle, and the rest still load (decision O2, M1).
 * Required: handle, party, scope (one of PARTY_SCOPES, matched trimmed and case-insensitively), verified, and at
 * least one keyword. A scope "mla" entry goes to `mla` only, whatever its spelling and whether verified or not, and
 * never into `rules`: nothing an MLA entry carries can reach the post.
 */
export function parsePartyHandles(json: unknown, problem: (message: string) => void = () => undefined): PartyRules {
  const root = json as Partial<PartyHandlesData> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.entries)) {
    throw new Error("party handles: expected { version, entries: [...] }");
  }
  const rules: PartyRule[] = [];
  const mla: PartyRule[] = [];
  const handles = new Set<string>();
  const types = new Map<string, HandleType>();
  const leaderRules: LeaderRule[] = [];
  root.entries.forEach((raw, i) => {
    const e = raw as Partial<PartyHandleEntry> | null;
    const where = `entries[${i}]`;
    if (!e || typeof e !== "object") return problem(`${where}: not an object, entry rejected`);
    if (typeof e.handle !== "string" || !HANDLE.test(e.handle.trim())) {
      return problem(`${where}: "${String(e.handle)}" is not an X handle, entry rejected`);
    }
    // Into the guard set before any other check: a rejected entry's handle is still never a desk keyword's to tag
    handles.add(e.handle.trim().replace(/^@/, "").toLowerCase());
    const who = `${where} (${e.handle.trim()})`;
    if (typeof e.scope !== "string" || !e.scope.trim()) return problem(`${who}: "scope" is missing, entry rejected (one of ${PARTY_SCOPES.join(", ")})`);
    const scope = e.scope.trim().toLowerCase();
    if (!SCOPES.has(scope)) return problem(`${who}: unknown scope "${e.scope}", entry rejected (one of ${PARTY_SCOPES.join(", ")})`);
    if (typeof e.party !== "string" || !e.party.trim()) return problem(`${who}: "party" is missing, entry rejected`);
    // P4: the guard narrows the type; a missing or unknown one rejects this entry, named (O2)
    const type = e.handle_type;
    if (!isHandleType(type)) return problem(`${who}: ${handleTypeProblem(type)}, entry rejected`);
    addHandleType(types, e.handle, type);
    if (typeof e.verified !== "boolean") return problem(`${who}: "verified" must be true or false, entry rejected`);
    if (badKeywords(e.keywords_hi)) return problem(`${who}: "keywords_hi" must be a list of strings, entry rejected`);
    if (badKeywords(e.keywords_en)) return problem(`${who}: "keywords_en" must be a list of strings, entry rejected`);
    if (e.name !== undefined && typeof e.name !== "string") return problem(`${who}: "name" must be a string, entry rejected`);
    if (e.hashtag !== undefined && !(typeof e.hashtag === "string" && /^#?[A-Za-z0-9_]+$/.test(e.hashtag.trim()))) {
      return problem(`${who}: "hashtag" must be one hashtag such as "BJP", entry rejected`);
    }
    const member = scope === "mla";
    // An MLA is only ever offered, so an unverified one is offered too; any other unverified entry is left out
    if (!e.verified && !member) return;
    const keys = [...strings(e.keywords_hi), ...strings(e.keywords_en)].map(fold).filter(Boolean);
    if (!keys.length) return problem(`${who}: no keywords to match on, entry rejected`);
    const party = e.party.trim().toLowerCase();
    const rule: PartyRule = {
      handle: e.handle.trim().replace(/^@/, ""),
      name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : party,
      party,
      scope,
      tokens: keys.filter((k) => !k.includes(" ")),
      phrases: keys.filter((k) => k.includes(" ")),
      ...(e.hashtag && (scope === "state" || scope === "national") && { hashtag: e.hashtag.trim().replace(/^#/, "") }),
    };
    (member ? mla : rules).push(rule);
    const leader = parseLeaders(e, rule, (m) => problem(`${who}: ${m}; the leaders block is ignored, the entry still loads`));
    if (leader) leaderRules.push(leader);
  });
  return { rules, count: rules.length, mla, handles, types, leaderRules };
}

const isHandleList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && HANDLE.test(x.trim()));
const isOptionalStrings = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));

/**
 * The entry's leaders block (Changes #3 §2.1), or null when it has none. Only a party's own state or national handle
 * may carry one: an MLA, a wing or a media cell is never offered on a leader's behalf.
 */
function parseLeaders(e: Partial<PartyHandleEntry>, rule: PartyRule, problem: (message: string) => void): LeaderRule | null {
  if (e.leaders === undefined && e.leader_names === undefined && e.leader_first_for_reporters === undefined && e.leader_reason === undefined) return null;
  if (rule.scope !== "state" && rule.scope !== "national") return problem(`a leaders block is only read on a "state" or "national" entry, not "${rule.scope}"`), null;
  if (!isHandleList(e.leaders)) return problem(`"leaders" must be a non-empty list of X handles`), null;
  if (!isOptionalStrings(e.leader_names)) return problem(`"leader_names" must be a list of strings`), null;
  if (e.leader_first_for_reporters !== undefined && !(Array.isArray(e.leader_first_for_reporters) && e.leader_first_for_reporters.every((x) => typeof x === "string" && HANDLE.test(x.trim())))) {
    return problem(`"leader_first_for_reporters" must be a list of X handles`), null;
  }
  if (e.leader_reason !== undefined && (typeof e.leader_reason !== "string" || !e.leader_reason.trim())) return problem(`"leader_reason" must be a non-empty string`), null;
  const bare = (h: string) => h.trim().replace(/^@/, "").toLowerCase();
  const names = strings(e.leader_names).map((n) => fold(n.normalize("NFC"))).filter(Boolean);
  return {
    handle: rule.handle,
    name: rule.name,
    party: rule.party,
    leaders: new Set(e.leaders.map(bare)),
    nameTokens: names.filter((k) => !k.includes(" ")),
    namePhrases: names.filter((k) => k.includes(" ")),
    firstFor: new Set((e.leader_first_for_reporters ?? []).map(bare)),
    reason: e.leader_reason?.trim() || `${rule.name} leader tagged`,
  };
}

/** What partyOfLeader offers */
export interface LeaderOffer {
  /** The party handle, without the @ */
  handle: string;
  name: string;
  reason: string;
  /** The filing reporter is one the desk puts this offer first for */
  first: boolean;
}

/**
 * Changes #3 §2.1: a party to OFFER because one of its leaders is on the draft. `present` is every handle already on
 * the draft or offered (the emitted handles and the suggestions, after every other rule). Fires when a leader's handle
 * is among them, or a leader's name is in the copy, and none of the party's own state or national handles is. Never
 * tags, and changes nothing already there. One offer per party, file order.
 */
export function partyOfLeader(text: string, present: readonly { handle: string }[], rules: PartyRules, reporterHandle?: string | null): LeaderOffer[] {
  const list = rules.leaderRules ?? [];
  if (!list.length) return [];
  const have = new Set(present.map((p) => p.handle.replace(/^@/, "").toLowerCase()));
  const f = fold(text.normalize("NFC"));
  const words = new Set(f.split(" ").filter(Boolean));
  const reporter = reporterHandle ? reporterHandle.replace(/^@/, "").toLowerCase() : null;
  const out: LeaderOffer[] = [];
  for (const l of list) {
    // The party's own handles: the one offered and its state or national twin (@INCRajasthan / @INCIndia)
    const own = rules.rules.filter((r) => r.party === l.party && (r.scope === "state" || r.scope === "national")).map((r) => r.handle.toLowerCase());
    if ([l.handle.toLowerCase(), ...own].some((h) => have.has(h)) || out.some((o) => o.handle.toLowerCase() === l.handle.toLowerCase())) continue;
    const leaderOn = [...l.leaders].some((h) => have.has(h));
    const named = l.nameTokens.some((k) => words.has(k)) || l.namePhrases.some((p) => f.includes(p));
    if (!leaderOn && !named) continue;
    out.push({ handle: l.handle, name: l.name, reason: l.reason, first: !!reporter && l.firstFor.has(reporter) });
  }
  return out;
}

/** The rules of a list the text names: tokens as whole words, phrases as substrings of the folded text */
function hitsIn(text: string, list: readonly PartyRule[]): PartyRule[] {
  if (!list.length) return [];
  const f = fold(text.normalize("NFC"));
  const words = new Set(f.split(" ").filter(Boolean));
  return list.filter((r) => r.tokens.some((k) => words.has(k)) || r.phrases.some((p) => f.includes(p)));
}

/** Every party rule the text names */
function partyHits(text: string, rules: PartyRules): PartyRule[] {
  return rules.count ? hitsIn(text, rules.rules) : [];
}

/**
 * The MLA handles the text names, in file order, each once: OFFERED on the draft, never tagged on the post
 * (user decision, 13 Nov 2026). They play no part in the party picks or the clash rule.
 */
export function pickMlaHandles(text: string, rules: PartyRules): PartyRule[] {
  return hitsIn(text, rules.mla ?? []);
}

/**
 * Whether the text names any party at all — the political half of the `namedPolitical` hint that
 * storyclass.ts needs, and true even for a clash story naming two parties (which tags neither).
 */
export function namesAnyParty(text: string, rules: PartyRules): boolean {
  return partyHits(text, rules).length > 0;
}

/**
 * Election mode (owner, 20 Nov 2026): EVERY party the copy names, headline or points, one handle each — the state
 * handle on a Rajasthan story, the national one elsewhere — in the order the copy first names them. Both parties
 * named means both tagged: on a result story ("कांग्रेस 24, भाजपा 8") the desk tags both (Bikaner, 20 Nov:
 * @INCRajasthan and BJP). Wings, media cells and MLAs are never among them.
 */
export function namedParties(text: string, rules: PartyRules, rajasthan: boolean): PartyRule[] {
  if (!rules.count) return [];
  const f = fold(text.normalize("NFC"));
  const words = f.split(" ").filter(Boolean);
  const firstAt = (r: PartyRule): number => {
    const at = [...r.tokens.map((k) => words.indexOf(k)), ...r.phrases.map((p) => (f.includes(p) ? f.slice(0, f.indexOf(p)).split(" ").filter(Boolean).length : -1))].filter((i) => i >= 0);
    return at.length ? Math.min(...at) : Number.MAX_SAFE_INTEGER;
  };
  const hits = partyHits(text, rules).filter((h) => h.scope === "state" || h.scope === "national");
  const out: PartyRule[] = [];
  for (const party of new Set(hits.map((h) => h.party))) {
    const own = preferred(hits.filter((h) => h.party === party), rajasthan);
    if (own) out.push(own);
  }
  // "First named" across all of a party's handles' keywords, so BJP named first stays first
  const order = (r: PartyRule) => Math.min(...hits.filter((h) => h.party === r.party).map(firstAt));
  return out.sort((a, b) => order(a) - order(b));
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
