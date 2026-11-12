// Which official X accounts a breaking post tags. Rebuilt from published output rather than from
// guesses: 1,002 posts from @1stIndiaNews (602 from 9–10 Nov 2026, Diwali week; 400 from 30 Oct 2026, a
// panchayat polling day), every handle and every combination counted.
//
// ─── WHAT THE DESK ACTUALLY DOES ─────────────────────────────────────────────
//
// How many handles per post:            Which roles, and how often alone:
//   0 handles   199   19.9%               police      303 uses, 248 of them the ONLY handle (82%)
//   1 handle    485   48.4%               collector   117 uses, 101 of them the ONLY handle (86%)
//   2 handles   204   20.4%               politician  230 uses, usually with a party and a reporter
//   3 handles   100   10.0%               party       101 uses, never with police or a collector
//   4+          14     1.4%               reporter    339 uses, LAST in 290 of them (85.5%)
//
// Four findings drive the rules below, and each contradicts the implementation before it:
//
//   1. 19.9% OF POSTS TAG NOBODY. Festivals, pujas, obituaries, columns, election machinery and result
//      bulletins. So a fallback that tags @RajGovOfficial whenever nothing else fires is wrong: it would
//      fire on all 199. Across both windows @RajGovOfficial appeared on 83 posts, every one of them
//      state-administration copy — the secretariat, state commissions, government employees, state
//      schemes — and not one a district incident or a festival. It is a beat, not a fallback.
//
//   2. THE CEILING IS 3, NOT 2. 114 posts carried three or more handles, nearly all political. `max = 2`
//      silently dropped the party or the reporter on every one.
//
//   3. POLICE AND THE COLLECTOR ARE EXCLUSIVE. An incident gets the district police and stops; an
//      administration story gets the collector and stops. Our own reporter rode along on only 14.6% and
//      6.0% of those, against 54–67% for political and government copy.
//
//   4. PARTY NEWS TAGS THE PARTY. 99 party tags in two days, every one of which the old PARTY regex
//      dropped. What that guard was protecting is still true and still enforced: no police handle and no
//      collector ever appears beside a party.
//
// ─── THE SAFETY MODEL, UNCHANGED ─────────────────────────────────────────────
//
// Only `verified` handles from the editable data files are ever tagged. A wrong government tag is a
// reputational incident, so every rule still errs towards tagging nobody: a leader's own post tags
// nobody, copy from outside Rajasthan tags no state institution, another district's officer is not ours,
// an unknown reporter tags nobody, and nothing here can invent a handle that is not in a data file.

import { fold } from "../fold";
import { EMPTY_DESK_HANDLE_RULES, fileLookalike, type DeskHandleRules } from "./desk-handles";
import { EMPTY_PARTY_RULES, namesAnyParty, pickParty, pickPartyWing, type PartyRules } from "./parties";
import { districtMismatch, EMPTY_REPORTER_RULES, pickReporter, type ReporterRules } from "./reporters";
import { classify, type StoryClass } from "./storyclass";
import { EMPTY_SUBJECT_RULES, subjectExcluded, type SubjectRules } from "./subjects";

/** One entry of district-handles.json */
export interface DistrictHandleEntry {
  /** "@CP_Jodhpur" (the @ is optional) */
  handle: string;
  role: "police" | "collector" | "govt" | "cm";
  verified: boolean;
  source?: string;
  /** How many published posts corroborated this handle for this district */
  evidence?: number;
}

/** district-handles.json */
export interface HandlesData {
  version: number;
  state: DistrictHandleEntry[];
  /** Keyed by district (English name or tag: "Sawai Madhopur" / "SawaiMadhopur") */
  districts: Record<string, DistrictHandleEntry[]>;
}

/** The verified handles only, by use; handles without the @ */
export interface HandleRules {
  state: { government: string[]; cm: string[]; police: string[] };
  /** Keyed by districtKey() of the district */
  districts: Record<string, { police: string[]; collector: string[] }>;
  /**
   * Every handle in the file, verified or not, lowercase without the @: the desk-added handles rule never
   * tags these or their lookalikes (desk-handles.ts)
   */
  all?: ReadonlySet<string>;
}

export const EMPTY_HANDLE_RULES: HandleRules = { state: { government: [], cm: [], police: [] }, districts: {} };

const HANDLE = /^@?\w{1,15}$/;
const ROLES = new Set(["police", "collector", "govt", "cm"]);
/** "Sawai Madhopur", "SawaiMadhopur" and "sawai-madhopur" are one key */
export const districtKey = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();

/**
 * Checks a parsed district-handles.json and keeps only verified entries. A malformed file throws with the
 * first problem (the worker then keeps its last good copy); an unverified entry is simply left out.
 */
export function parseHandleRules(json: unknown): HandleRules {
  const fail = (msg: string): never => {
    throw new Error(`district handles: ${msg}`);
  };
  const root = json as Partial<HandlesData> | null;
  if (!root || typeof root !== "object") fail("expected { version, state: [...], districts: {...} }");
  const entries = (v: unknown, where: string): DistrictHandleEntry[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(`${where} must be a list`);
    return (v as Partial<DistrictHandleEntry>[]).map((e, i) => {
      if (!e || typeof e.handle !== "string" || !HANDLE.test(e.handle)) fail(`${where}[${i}]: "${String(e?.handle)}" is not an X handle`);
      if (!ROLES.has(String(e!.role))) fail(`${where}[${i}]: role must be police, collector, govt or cm`);
      if (typeof e!.verified !== "boolean") fail(`${where}[${i}]: "verified" must be true or false`);
      return e as DistrictHandleEntry;
    });
  };
  const bare = (e: DistrictHandleEntry) => e.handle.replace(/^@/, "");
  const all = new Set<string>();
  const rules: HandleRules = { state: { government: [], cm: [], police: [] }, districts: {}, all };
  for (const e of entries(root!.state, "state")) {
    all.add(bare(e).toLowerCase());
    if (!e.verified) continue;
    if (e.role === "govt") rules.state.government.push(bare(e));
    else if (e.role === "cm") rules.state.cm.push(bare(e));
    else if (e.role === "police") rules.state.police.push(bare(e));
  }
  if (root!.districts !== undefined && (typeof root!.districts !== "object" || Array.isArray(root!.districts))) fail("districts must be an object keyed by district");
  for (const [name, list] of Object.entries(root!.districts ?? {})) {
    if (name.startsWith("_")) continue;
    // districtKey strips everything but ASCII letters and digits, so a name written only in Devanagari
    // would key on "" — and then every district whose name does not fold to ASCII would read that one
    // bucket's handles. The file is keyed by English name; say so rather than tag the wrong force.
    const key = districtKey(name);
    if (!key) fail(`districts.${name}: a district must be keyed by its English name`);
    // "Sawai Madhopur" and "SawaiMadhopur" are one district: merge, never let the later spelling
    // silently replace the earlier one's verified handles
    const d = rules.districts[key] ?? { police: [] as string[], collector: [] as string[] };
    for (const e of entries(list, `districts.${name}`)) {
      all.add(bare(e).toLowerCase());
      if (e.verified && (e.role === "police" || e.role === "collector") && !d[e.role].includes(bare(e))) d[e.role].push(bare(e));
    }
    rules.districts[key] = d;
  }
  return rules;
}

// ─── Acting agents: unchanged, and still needed ─────────────────────────────
//
// The class-driven rules below cover the shapes the desk uses most. This machinery still decides the
// residual: the police on a NON-incident story ("पुलिस ने निकाली तिरंगा यात्रा"), the collector, police
// headquarters, whether a police or department subject is actually acting — and, on an incident, whether
// the officer the copy names belongs to ANOTHER district, which is the one case where a district's own
// police must not be tagged.

type Agent = "police" | "collector";

const folded = (words: string[]) => new Set(words.map(fold));
/** One-word titles of the district police and the collector */
const AGENT_WORDS = new Map<string, Agent>([
  ...[
    "थानाधिकारी", "थानाप्रभारी", "एसएचओ", "SHO", "एसपी", "SP", "एएसपी", "ASP", "डीएसपी", "DSP", "डीसीपी", "DCP", "एडीसीपी", "ADCP", "सीओ", "कोतवाल",
    "सीआई", "CI", "एसआई", "SI", "एएसआई", "ASI", "डीएसटी", "DST",
  ].map((w) => [fold(w), "police"] as [string, Agent]),
  ...["कलेक्टर", "कलक्टर", "जिलाधिकारी", "जिलाधीश", "डीएम", "DM"].map((w) => [fold(w), "collector"] as [string, Agent]),
]);
/** Two-word titles; "पुलिस" alone is the institution (below). The flag: a name may follow (a person's title) */
const AGENT_PAIRS: [string, string, Agent, boolean][] = (
  [
    ["थाना", "प्रभारी", "police", true], ["थाना", "अधिकारी", "police", true], ["पुलिस", "अधीक्षक", "police", true], ["पुलिस", "उपाधीक्षक", "police", true],
    ["पुलिस", "कमिश्नर", "police", true], ["पुलिस", "आयुक्त", "police", true], ["पुलिस", "प्रशासन", "police", false],
    ["जिला", "प्रशासन", "collector", false], ["जिला", "मजिस्ट्रेट", "collector", true],
  ] as [string, string, Agent, boolean][]
).map(([a, b, k, title]) => [fold(a), fold(b), k, title]);
const POLICE = fold("पुलिस");
const ADMINISTRATION = fold("प्रशासन");
/** "पुलिस की टीम ने", "पुलिस टीम ने", "पुलिस के जवानों ने" */
const TEAM = folded(["टीम", "टीमों", "टीमें", "जवानों", "जवान", "जाब्ते", "जाब्ता", "अधिकारियों"]);
const POSSESSIVE = folded(["का", "की", "के"]);
const AND = folded(["व", "और", "एवं", "तथा"]);
/** Words that end a title's name run: postpositions, conjunctions, the agent marker */
const NAME_STOP = folded(["ने", "का", "की", "के", "को", "से", "में", "पर", "द्वारा", "व", "और", "एवं", "तथा", "भी", "ही", "तक", "लिए"]);
/** What an agent does, as a noun after का/की/के: "पुलिस की बड़ी कार्रवाई", "कलेक्टर की अध्यक्षता" */
const ACTION_NOUNS = folded([
  "कार्रवाई", "कार्यवाही", "खुलासा", "सफलता", "कामयाबी", "गिरफ्त", "एक्शन", "सख्ती", "आदेश", "आदेशों", "निर्देश", "निर्देशों", "निर्देशन",
  "अध्यक्षता", "निरीक्षण", "दौरा", "फैसला", "पहल", "नाकाबंदी", "दबिश", "छापा", "छापेमारी", "अभियान", "जांच",
]);
const ADJECTIVES = folded(["बड़ी", "बड़ा", "बड़े", "सख्त", "औचक", "ताबड़तोड़", "त्वरित"]);
const SUCCESS = folded(["सफलता", "कामयाबी"]);
/** Police at work now: "थाना पुलिस कर रही बदमाशों की तलाश", "पुलिस मामले की जांच में जुटी" */
const ONGOING = folded(["जुटी", "जुटे", "जुटा", "जुट"]);
const DOING = folded(["रही", "रहा", "रहे"]);
/** Between "पुलिस" and the verb: the police are the object or the place, not the agent */
const NOT_AGENT = folded(["पर", "को", "से", "थाने", "थाना", "चौकी", "ने"]);
const CLAUSE = /[,،।॥;!?|:\n]+|\s[-–—]\s/u;
/** "सेवानिवृत्त ASP", "पूर्व कलेक्टर": not the office acting now */
const FORMER = folded(["सेवानिवृत्त", "रिटायर्ड", "रिटायर", "पूर्व", "तत्कालीन"]);
const DISTRICT_WORD = folded(["जिला", "जिले"]);
/** "ACB सीआई ने", "जीआरपी पुलिस ने": another force, not the district police */
const OTHER_FORCE = folded([
  "ACB", "एसीबी", "SOG", "एसओजी", "CBI", "सीबीआई", "ED", "ईडी", "NIA", "एनआईए", "ATS", "एटीएस", "NCB", "एनसीबी", "CID", "सीआईडी", "GRP", "जीआरपी",
  "RPF", "आरपीएफ", "BSF", "बीएसएफ", "CISF", "सीआईएसएफ", "CRPF", "सीआरपीएफ", "आर्मी", "सेना",
]);
const POLICE_HQ = /पुलिस\s*मुख्यालय|डीजीपी|\bDGP\b|राजस्थान\s*पुलिस/gu;
const DGP = /डीजीपी|DGP/u;
const CM_SUBJECT = /(?:मुख्यमंत्री|सीएम|CM)\s*(?:श्री\s*)?भजनलाल|भजनलाल\s*शर्मा/u;
/**
 * The state government DECIDING: "राज्य सरकार ने", "...का फैसला", "...के आदेश"; never "राज्य सरकार के
 * खिलाफ धरना". Kept as a precise test rather than letting the `government` class tag @RajGovOfficial on
 * its own: the class fires on any departmental word, and the handle's 83 posts were all the secretariat,
 * a state commission, a state scheme or government employees — a beat, not everything with a विभाग in it.
 */
const GOVT_ACTS = String.raw`\s*(?:ने|(?:का|की|के)\s*(?:बड़ा\s*|बड़ी\s*|बड़े\s*|नई\s*|नया\s*)?(?:फैसला|फैसले|निर्णय|आदेश|निर्देश|योजना|घोषणा|मंजूरी|पहल|अधिसूचना))`;
const GOVT = new RegExp(String.raw`(?:राज्य|प्रदेश)\s*सरकार${GOVT_ACTS}|सरकार\s*का\s*(?:बड़ा\s*)?फैसला|सरकार\s*ने\s*(?:जारी|लिया|दी|किया)|कैबिनेट|मंत्रिमंडल|अधिसूचना\s*जारी|आदेश\s*जारी|भजनलाल\s*सरकार`, "u");
const NE = fold("ने");
const BY = fold("द्वारा");
const TO = fold("को");
const GOT = fold("मिली");
const DO = fold("कर");
const CUSTODY = fold("गिरफ्त");

/** The agent starting at tokens[i], how many tokens it spans, and whether a name may follow it */
function agentAt(t: string[], i: number): { kind: Agent; len: number; title: boolean } | null {
  for (const [a, b, kind, title] of AGENT_PAIRS) if (t[i] === a && t[i + 1] === b) return { kind, len: 2, title };
  const one = AGENT_WORDS.get(t[i] ?? "");
  if (one) return { kind: one, len: 1, title: true };
  if (t[i] === POLICE) return { kind: "police", len: 1, title: false };
  return null;
}

/** The action right after an agent run (tokens[j] on): "ने", "द्वारा", "की (बड़ी) कार्रवाई", "को (मिली) सफलता" */
function actsAt(t: string[], j: number, police: boolean): boolean {
  const w = t[j];
  if (w === undefined) return false;
  if (w === NE || w === BY) return true;
  let k = j + 1;
  if (POSSESSIVE.has(w)) {
    while (ADJECTIVES.has(t[k] ?? "")) k++;
    return ACTION_NOUNS.has(t[k] ?? "");
  }
  if (w === TO) {
    if (t[k] === GOT) k++;
    while (ADJECTIVES.has(t[k] ?? "")) k++;
    return SUCCESS.has(t[k] ?? "");
  }
  if (!police) return false;
  if (w === CUSTODY) return true;
  // Work in progress within a few words, with nothing that makes the police the object or the place
  for (let m = j; m < Math.min(t.length, j + 6); m++) {
    if (NOT_AGENT.has(t[m]!)) return false;
    if (ONGOING.has(t[m]!)) return true;
    if (t[m] === DO && DOING.has(t[m + 1] ?? "")) return true;
  }
  return false;
}

/** Agents the text names as acting, split by whether they are this story's district or another's */
export interface ActingAgents {
  /** Ours: the district police / collector of this story */
  ours: Set<Agent>;
  /** Named as acting, but belonging to another district ("बूंदी SP ने" in a Jaipur story) */
  elsewhere: Set<Agent>;
}

/**
 * Which of the district police and the collector the text names as acting, clause by clause. `elsewhere`
 * says a word names another district: "बूंदी SP ने" in a Jaipur story is not Jaipur's police, and it is
 * reported separately so an incident rule can decline to tag our own force.
 */
export function agentsActing(text: string, elsewhere: (word: string) => boolean = () => false): ActingAgents {
  const out: ActingAgents = { ours: new Set<Agent>(), elsewhere: new Set<Agent>() };
  for (const clause of text.normalize("NFC").split(CLAUSE)) {
    const t = fold(clause).split(" ").filter(Boolean);
    for (let i = 0; i < t.length; ) {
      if (!agentAt(t, i)) {
        i++;
        continue;
      }
      const kinds = new Set<Agent>();
      let j = i;
      // An agent run: "थाना पुलिस", "कलेक्टर टीना डाबी", "पुलिस व प्रशासन", "पुलिस की टीम"
      for (;;) {
        const a = agentAt(t, j);
        if (!a) break;
        kinds.add(a.kind);
        j += a.len;
        if (!a.title) {
          if (POSSESSIVE.has(t[j] ?? "") && TEAM.has(t[j + 1] ?? "")) j += 2;
          else if (TEAM.has(t[j] ?? "")) j += 1;
        } else {
          // A name after the title: up to 4 words that are not postpositions or another agent
          for (let n = 0; n < 4 && j < t.length && !NAME_STOP.has(t[j]!) && !agentAt(t, j); n++) j++;
        }
        if (AND.has(t[j] ?? "")) {
          if (agentAt(t, j + 1)) {
            j += 1;
            continue;
          }
          // "पुलिस व प्रशासन ने": the general administration joins the run but tags nobody itself
          if (t[j + 1] === ADMINISTRATION) j += 2;
        }
        break;
      }
      // What stands before the run: "सेवानिवृत्त", another force ("ACB सीआई"), or another district ("बूंदी SP",
      // "सवाई माधोपुर एसपी", "बूंदी जिले के एसपी", "बूंदी जिला पुलिस", "बूंदी के एसपी", "बूंदी की पुलिस").
      //
      // The possessive is stepped over on its own, not only as part of "जिले के". "बूंदी के एसपी ने" is
      // the commonest way the copy names another district's officer, and while this only looked for
      // "[district] [जिला|जिले] [का|की|के]" that sentence tagged OUR district's police — the one error
      // this whole file is built to avoid, and now the likeliest, because an incident tags the district
      // force whether or not the copy names it acting.
      let k = i - 1;
      if (POSSESSIVE.has(t[k] ?? "")) k -= 1;
      if (DISTRICT_WORD.has(t[k] ?? "")) k -= 1;
      const place = (t[k] !== undefined && elsewhere(t[k]!)) || (k >= 1 && elsewhere(`${t[k - 1]} ${t[k]}`));
      const former = FORMER.has(t[i - 1] ?? "") || OTHER_FORCE.has(t[i - 1] ?? "");
      if (actsAt(t, j, kinds.has("police"))) {
        for (const kk of kinds) {
          if (place) out.elsewhere.add(kk);
          else if (!former) out.ours.add(kk);
        }
      }
      i = Math.max(j, i + 1);
    }
  }
  return out;
}

/** The agents of THIS district the text names as acting. */
export function actingAgents(text: string, elsewhere: (word: string) => boolean = () => false): Set<Agent> {
  return agentsActing(text, elsewhere).ours;
}

/**
 * The subjects (by entry id) the text names as acting: the action right after the name ("जयपुर पुलिस ने",
 * "आरपीएससी की बड़ी कार्रवाई"), not a former office or another force before it. "जयपुर पुलिस पर पथराव" is not.
 */
function actingSubjects(text: string, subjects: SubjectRules): Set<string> {
  const out = new Set<string>();
  for (const clause of text.normalize("NFC").split(CLAUSE)) {
    const chars = [...fold(clause)];
    const t = chars.join("").split(" ").filter(Boolean);
    // Token index of a folded character position (fold leaves single spaces between words)
    const tokenAt = (pos: number) => chars.slice(0, pos).filter((c) => c === " ").length;
    for (const m of subjects.gazetteer.find(clause)) {
      const first = tokenAt(m.start);
      if (FORMER.has(t[first - 1] ?? "") || OTHER_FORCE.has(t[first - 1] ?? "")) continue;
      if (actsAt(t, tokenAt(m.end) + 1, m.entry.data.kind === "police")) out.add(m.entry.id);
    }
  }
  return out;
}

/**
 * Police HQ named as acting in the text: "डीजीपी (राजीव शर्मा) ने", "राजस्थान पुलिस की बड़ी कार्रवाई". Not "राजस्थान पुलिस के
 * जवान की मौत" or "पुलिस मुख्यालय पर प्रदर्शन".
 */
function policeHqActs(text: string): boolean {
  for (const clause of text.normalize("NFC").split(CLAUSE)) {
    for (const m of clause.matchAll(POLICE_HQ)) {
      const t = fold(clause.slice(m.index + m[0].length)).split(" ").filter(Boolean);
      let j = 0;
      // A name after the DGP's title; "के जवानों" after the force
      if (DGP.test(m[0])) for (let n = 0; n < 4 && j < t.length && !NAME_STOP.has(t[j]!); n++) j++;
      else if (POSSESSIVE.has(t[0] ?? "") && TEAM.has(t[1] ?? "")) j = 2;
      if (actsAt(t, j, true)) return true;
    }
  }
  return false;
}

/** Police and department subjects are tagged only when acting, as the district police are; people and the rest when named */
const ONLY_ACTING: ReadonlySet<string> = new Set(["police", "department"]);
/** A police or administrative venue: where a protest or a delegation goes (§3.2) */
const VENUE = /(?<![\p{L}\p{M}])(?:(?:पुलिस\s*)?कमिश्नरेट|पुलिस\s*आयुक्तालय|थाने|थाना|पुलिस\s*चौकी|एसपी\s*(?:कार्यालय|ऑफिस)|कलेक्ट्रेट|कलेक्टरेट|कलक्ट्रेट|कलेक्टर\s*(?:कार्यालय|ऑफिस)|जिला\s*मुख्यालय|घेराव)(?![\p{L}\p{M}])/u;
/** Classes where the district force or the collector stands alone: nothing of the desk's joins them */
const EXCLUSIVE: ReadonlySet<StoryClass> = new Set<StoryClass>(["incident", "administration"]);
/** Classes the desk puts our own reporter on (54–67% of posts), and never on an incident (14.6%) */
const WANTS_REPORTER: ReadonlySet<StoryClass> = new Set<StoryClass>(["political", "government", "other", "judicial"]);

export interface HandlePickInput {
  headline: string;
  points: string[];
  /** stories.district: the district the copy states. It also sets the post's visible hashtag. */
  district: string | null;
  rajasthan: boolean;
  leaderPost: boolean;
  /** The file's headline line before its place prefix was taken off ("#BJP #Kota: ..."), when known */
  rawHeadline?: string;
  /**
   * The district the file name's code states (slotFromTags().district). A FALLBACK, not an override:
   * measured over 6,878 of this desk's files it fills a gap the copy left 18 times and disagrees with
   * the copy 195 times, and the copy is what the post's hashtag shows.
   */
  fileDistrict?: string | null;
  /** The reporter token from the file name (slotFromTags().reporterToken). Never read from the post text. */
  reporterToken?: string | null;
  /** slotFromTags().unknownCode — a code-shaped token the places file does not carry. Surfaced as a warning. */
  unknownBureauCode?: string | null;
  /** Whether a word names a district other than the story's (from the places file); none: never */
  elsewhere?: (word: string) => boolean;
}

export interface HandlePick {
  handle: string;
  /** Why: shown on the draft as the suggestion's entity */
  reason: "cm" | "police" | "collector" | "government" | "state_police" | "subject" | "desk" | "party" | "reporter";
  /** The subject's title, the party's name, the reporter's name, or the directory name (reason "desk") */
  title?: string;
}

export interface HandleResult {
  handles: HandlePick[];
  /** The story class every rule hung off, for the draft's audit line */
  cls: StoryClass;
  why: string;
  /**
   * Things the desk should see that never block a tag: a reporter token the roster does not carry, a
   * code the places file does not carry, a reporter whose districts disagree with the story's. The
   * unmatched tokens are how the roster gets completed — log them.
   */
  warnings: string[];
  /**
   * The file named a reporter this post would have carried a byline for, and the list does not have
   * them. A field rather than a string in `warnings` so callers can tell this apart from a real problem:
   * it is true of about 45% of files today and will stay common until the list fills in.
   */
  unmatchedReporter: string | null;
  /**
   * Handles OFFERED to the desk, never tagged on their own (one click to add): the district police on party
   * copy at a police or administrative venue (§3.2), an institution political copy names only in passing
   * in its body (§3.3). Only ever handles of the data files.
   */
  suggestions: HandlePick[];
}

export interface PickOptions {
  subjects?: SubjectRules;
  /** Handles the desk added with keywords (the org's handle_directory, source "desk") */
  desk?: DeskHandleRules;
  reporters?: ReporterRules;
  parties?: PartyRules;
  /**
   * The ceiling. 3 is what the desk uses: 114 of 1,002 posts carried 3 or more handles, nearly all
   * political. Raise to 4 only if the political 4-handle shape (two leaders + party + reporter) matters
   * more than the risk of a wider tag.
   */
  max?: number;
}

/** One entry per handle, first occurrence wins */
function dedupe(picks: readonly HandlePick[]): HandlePick[] {
  const out: HandlePick[] = [];
  for (const p of picks) if (!out.some((o) => o.handle.toLowerCase() === p.handle.toLowerCase())) out.push(p);
  return out;
}

/** Every handle the district-handles rules can tag, lowercase */
function ruleHandles(rules: HandleRules): Set<string> {
  const all = [...rules.state.government, ...rules.state.cm, ...rules.state.police, ...Object.values(rules.districts).flatMap((d) => [...d.police, ...d.collector])];
  return new Set(all.map((h) => h.toLowerCase()));
}

/**
 * 0–3 verified handles for the post, with the class they were chosen by.
 *
 * The shape is chosen by story class, because that is what the published output says drives it:
 *
 *   leader_post    → nobody, not even the reporter
 *   soft           → nobody (19.9% of posts: festivals, pujas, obituaries, columns, election bulletins)
 *   judicial       → our reporter only, no institution (16 of 22 court posts)
 *   incident       → the district police, ALONE (248 of 302 police tags were the only handle)
 *   administration → the district collector, ALONE (101 of 117)
 *   political      → named leaders, then the party, then our reporter (the 3- and 4-handle shape)
 *   government     → the department or the state government, then our reporter
 *   other          → subjects named in the copy, then our reporter; nobody if nothing is named
 *
 * Within a class a handle found in the headline ranks before one found in the body, handles the desk
 * added come after the files' own, and the reporter is always last (290 of 339 placements).
 */
export function pickHandlesExplained(story: HandlePickInput, rules: HandleRules, opts: PickOptions = {}): HandleResult {
  const {
    subjects = EMPTY_SUBJECT_RULES, desk = EMPTY_DESK_HANDLE_RULES, reporters = EMPTY_REPORTER_RULES, parties = EMPTY_PARTY_RULES, max = 3,
  } = opts;
  const warnings: string[] = [];

  // The desk's own tag run is part of the headline for classification: a file whose line 1 is
  // "#BJP #Kota: ..." is party copy even after the parser has taken the prefix off the stored headline.
  const head = (story.rawHeadline?.trim() || story.headline).normalize("NFC");
  const body = story.points.join("\n").normalize("NFC");
  const all = `${head}\n${body}`;

  // The copy's district decides, because it is also what the post's hashtag shows. The file name's code
  // fills a gap and cross-checks it.
  const district = story.district || story.fileDistrict || null;
  if (story.fileDistrict && story.district && districtKey(story.fileDistrict) !== districtKey(story.district)) {
    warnings.push(`the file name says ${story.fileDistrict}, the copy says ${story.district}; the copy decides (it sets the hashtag)`);
  }
  if (story.unknownBureauCode) {
    warnings.push(`the file name's district code "${story.unknownBureauCode}" is not in the places file; add it there to use it`);
  }
  const local = district ? rules.districts[districtKey(district)] : undefined;

  // Devanagari gives proper nouns no orthographic cue, so a headline that is nothing but "अशोक गहलोत"
  // has no political signal without this hint. Measured: political recall 92.5% with it, 84.4% without.
  const namedPolitical =
    (subjects.count > 0 && subjects.gazetteer.find(head).some((m) => m.entry.data.kind === "person" && !subjectExcluded(m, all))) || namesAnyParty(head, parties);
  const { cls, why } = classify({ headline: head, points: story.points, leaderPost: story.leaderPost, namedPolitical });

  // The reporter, resolved now and appended last. An unresolved name is reported, never guessed at.
  const rep = pickReporter(story.reporterToken, reporters);
  let unmatchedReporter: string | null = null;
  let noted = false;
  /**
   * Called where a byline slot really exists. A crime story in Rajasthan has none — the district force
   * takes the post — so saying "no byline" there would bury the warnings that do mean something. The
   * name itself is still stored on the draft whatever the class, so an editor's edit can still teach it.
   */
  const noteByline = () => {
    if (noted) return;
    noted = true;
    unmatchedReporter = rep.unmatchedToken;
    if (rep.match && districtMismatch(rep.match, district)) {
      warnings.push(`@${rep.match.handle} usually files from ${rep.match.districts.join("/")}, not ${district}`);
    }
  };

  const picks: (HandlePick & { inHeadline: boolean })[] = [];
  const add = (handles: string[] | undefined, reason: HandlePick["reason"], inHeadline: boolean, title?: string) => {
    // One handle per use is enough: the first verified one
    const h = handles?.[0];
    if (h) picks.push({ handle: h, reason, inHeadline, ...(title && { title }) });
  };
  /**
   * The district's own force. Four districts have two verified ones — a city commissionerate and a rural
   * SP (Jaipur, Jodhpur, Kota, Khairthal-Tijara) — and which one a story belongs to is decided by the
   * police-station town, a list the desk has not confirmed yet. The first is used and the draft says so,
   * because otherwise nothing would tell the desk a rural story went out tagging the city force.
   */
  const addDistrictPolice = (inHeadline: boolean) => {
    if (!local?.police.length) return;
    add(local.police, "police", inHeadline);
    if (local.police.length > 1) {
      warnings.push(`${district} has ${local.police.length} police handles (@${local.police.join(", @")}); @${local.police[0]} was used — check the town`);
    }
  };
  const namedSubjects = (text: string, inHeadline: boolean) => {
    if (!subjects.count) return;
    const acting = actingSubjects(text, subjects);
    const found = subjects.gazetteer
      .find(text)
      .filter((m) => (!ONLY_ACTING.has(m.entry.data.kind) || acting.has(m.entry.id)) && !subjectExcluded(m, all))
      .sort((a, b) => a.start - b.start);
    for (const m of found) add([m.entry.data.handle], "subject", inHeadline, m.entry.data.title);
  };

  const suggested: HandlePick[] = [];
  const done = (handles: HandlePick[]): HandleResult => ({
    handles, cls, why, warnings, unmatchedReporter,
    suggestions: dedupe(suggested).filter((s) => !handles.some((h) => h.handle.toLowerCase() === s.handle.toLowerCase())),
  });
  // Copy from outside Rajasthan tags no state institution. Our own reporter still goes on it — the
  // Delhi-datelined posts in the window carried @vyaskamalkant or @ashvinigokul and nothing else.
  const onlyReporter = (): HandleResult => {
    // Outside Rajasthan there is no district force to take the post, so the byline is the whole tag
    noteByline();
    return done(rep.match && max > 0 ? [{ handle: rep.match.handle, reason: "reporter", title: rep.match.name }] : []);
  };

  // ── a leader's own post: nobody at all, not even the desk's own handle ────
  if (cls === "leader_post") return done([]);

  // Handles the desk added with keywords, computed here because they ride on every class except the two
  // where the district force stands alone. Never a handle of the files (verified or not) nor a lookalike
  // of one: the files' own rules decide when those are tagged.
  const deskPicks: HandlePick[] = [];
  if (desk.count && story.rajasthan && !EXCLUSIVE.has(cls)) {
    const governed = new Set([...(rules.all ?? ruleHandles(rules)), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
    // Headline matches before body matches, as the files' own picks are ordered
    for (const text of [head, body]) {
      for (const m of desk.gazetteer.find(text).sort((a, b) => a.start - b.start)) {
        if (fileLookalike(m.entry.data.handle, governed) === null) deskPicks.push({ handle: m.entry.data.handle, reason: "desk", title: m.entry.data.title });
      }
    }
  }

  // ── soft: no institution and no byline — the 19.9% the desk tags nobody on ─
  // The desk's own handles are not an institution: the org asked for that keyword, so a fair or a puja
  // still reaches the local handle it was added for.
  if (cls === "soft") return done(dedupe(deskPicks).slice(0, max));

  if (cls === "judicial") {
    // ── judicial: our reporter, and no institution ──────────────────────────
    // 16 of 22 court posts tagged the reporter and nothing else: a court story tags no police however
    // much आरोपी and जमानत the copy carries.
    if (!story.rajasthan) return onlyReporter();
  } else if (cls === "incident") {
    // ── incident: the district police, alone ────────────────────────────────
    if (!story.rajasthan) return onlyReporter();
    // An incident in the district tags its police whether or not the copy names them as the actor —
    // "बेकाबू कार ने मारी टक्कर" names no police and the desk tagged @KotaPolice every time. The one
    // exception is the guard that predates this patch: when the only officer the copy names as acting
    // belongs to ANOTHER district, ours are not the force in the story.
    const acting = agentsActing(all, story.elsewhere);
    if (!(acting.elsewhere.has("police") && !acting.ours.has("police"))) addDistrictPolice(true);
    if (policeHqActs(head)) add(rules.state.police, "state_police", true);
    // A police subject in subject-handles.json that is acting (another force, a railway police unit)
    namedSubjects(head, true);
    if (!picks.length) namedSubjects(body, false);
  } else if (cls === "administration") {
    // ── administration: the collector, alone ────────────────────────────────
    if (!story.rajasthan) return onlyReporter();
    // The collector is tagged whether or not the copy names them as the actor, for the same reason the
    // police are on an incident: 101 of 117 collector tags were the only handle on the post, and the
    // copy often names only the office ("जिला प्रशासन अलर्ट").
    const acting = agentsActing(all, story.elsewhere);
    if (!(acting.elsewhere.has("collector") && !acting.ours.has("collector"))) {
      add(local?.collector, "collector", acting.ours.has("collector"));
    }
    namedSubjects(head, true);
  } else if (cls === "political") {
    // ── political: leaders, then the party, then the reporter ───────────────
    // The CM is a subject when the headline names him; he is also the most-tagged handle in the windows.
    if (CM_SUBJECT.test(head)) add(rules.state.cm, "cm", true);
    namedSubjects(head, true);
    // A party wing the HEADLINE names outranks everything the body merely mentions: "कांग्रेस के छात्र संगठन
    // NSUI ..." is NSUI's story, and the body's "राजस्थान यूनिवर्सिटी छात्रसंघ" is a passing reference (§3.3:
    // the literal organisation over the thematically adjacent one).
    const wing = pickPartyWing(head, parties, story.rajasthan);
    if (wing) picks.push({ handle: wing.handle, reason: "party", inHeadline: true, title: wing.name });
    const named = new Set(picks.map((p) => p.handle.toLowerCase()));
    // Only when the headline names a party or wing literally: there the body's institutions are adjacent to
    // the story, not its subject. Elsewhere ("CM का जैसलमेर दौरा ... BSF") the body's institution is tagged as before.
    const headNamesOrg = namesAnyParty(head, parties);
    if (subjects.count) {
      const acting = actingSubjects(body, subjects);
      for (const m of subjects.gazetteer.find(body).sort((a, b) => a.start - b.start)) {
        if (ONLY_ACTING.has(m.entry.data.kind) && !acting.has(m.entry.id)) continue;
        if (named.has(String(m.entry.data.handle).toLowerCase()) || subjectExcluded(m, all)) continue;
        // A leader the body names rides on political copy; an institution named only in the body of a story
        // whose headline names a party is offered instead — @UniRajOfficial took the first slot of the NSUI
        // story from one mention of "राजस्थान यूनिवर्सिटी" in point 5.
        if (m.entry.data.kind === "person" || !headNamesOrg) add([m.entry.data.handle], "subject", false, m.entry.data.title);
        else suggested.push({ handle: m.entry.data.handle, reason: "subject", title: m.entry.data.title });
      }
    }
    const party = pickParty(all, parties, story.rajasthan);
    if (party) picks.push({ handle: party.handle, reason: "party", inHeadline: false, title: party.name });
    // NOTE: no police and no collector TAGGED in this branch, on purpose. Across 1,002 posts no party tag
    // appeared beside a district police handle or a collector except twice, both desk slips.
    //
    // But party copy AT a police or administrative venue (a protest at the commissionerate, a gherao of the
    // collectorate) is different: of 41 such posts the desk tagged the party on 40 and ALSO the police on 27
    // (§3.2). Additive, and a suggestion — the desk is itself inconsistent here — never a reclassification.
    if (story.rajasthan && VENUE.test(all)) {
      const police = local?.police[0];
      if (police) suggested.push({ handle: police, reason: "police" });
    }
  } else if (cls === "government" || cls === "other") {
    // ── government and other: whatever the copy names, else nobody ──────────
    //
    // One branch, because the difference between "a department story" and "an unclassified story" is not
    // a difference in who gets tagged: both tag the institutions the copy actually names, and both carry
    // our reporter. What separates them from the classes above is that nothing is assumed from the
    // district — an institution is tagged here only when the copy names it, and acting where its own
    // rule says so.
    if (!story.rajasthan) return onlyReporter();
    namedSubjects(head, true);
    if (!picks.length) namedSubjects(body, false);
    const headActs = agentsActing(head, story.elsewhere).ours;
    const bodyActs = agentsActing(body, story.elsewhere).ours;
    // The police acting on a non-incident story: "पुलिस ने निकाली तिरंगा यात्रा"
    if (headActs.has("police") || bodyActs.has("police")) addDistrictPolice(headActs.has("police"));
    if (headActs.has("collector") || bodyActs.has("collector")) add(local?.collector, "collector", headActs.has("collector"));
    // Police headquarters is a state institution: "DGP ने ली अधिकारियों की बैठक" tagged @PoliceRajasthan
    if (policeHqActs(head)) add(rules.state.police, "state_police", true);
    // @RajGovOfficial only where the state government is the one deciding
    if (GOVT.test(head)) add(rules.state.government, "government", true);
    else if (GOVT.test(body)) add(rules.state.government, "government", false);
  } else {
    // A class added to storyclass.ts with no branch here must not fall into the one above and start
    // tagging police and the state government; the compiler stops that from compiling at all.
    const unhandled: never = cls;
    void unhandled;
    return done([]);
  }

  // Headline picks first (stable), then the desk's; one entry per handle
  const ranked = dedupe([
    ...[...picks.filter((p) => p.inHeadline), ...picks.filter((p) => !p.inHeadline)].map(({ inHeadline: _drop, ...p }) => p),
    ...deskPicks,
  ]);

  // The reporter takes the last slot, on the classes the desk puts it on
  if (WANTS_REPORTER.has(cls)) noteByline();
  const wants = WANTS_REPORTER.has(cls) && rep.match && !ranked.some((o) => o.handle.toLowerCase() === rep.match!.handle.toLowerCase());
  const mine = wants ? rep.match! : null;
  const out = ranked.slice(0, mine ? Math.max(0, max - 1) : max);
  if (mine && max > 0) out.push({ handle: mine.handle, reason: "reporter", title: mine.name });
  return done(out);
}

/** The handles only. `pickHandlesExplained` additionally returns the class, the reason and any warnings. */
export function pickHandles(story: HandlePickInput, rules: HandleRules, opts: PickOptions = {}): HandlePick[] {
  return pickHandlesExplained(story, rules, opts).handles;
}
