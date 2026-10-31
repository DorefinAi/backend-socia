// Which official X accounts a breaking post tags: 0 to 2, chosen by rules, and only handles marked verified
// in the editable district-handles file (apps/worker/config/district-handles.json). A wrong government tag is
// a reputational incident, so every rule errs towards tagging nobody. The people and organisations a story is
// about come from subject-handles.json (subjects.ts).

import { fold } from "../fold";
import { EMPTY_SUBJECT_RULES, type SubjectRules } from "./subjects";

/** One entry of district-handles.json */
export interface DistrictHandleEntry {
  /** "@CP_Jodhpur" (the @ is optional) */
  handle: string;
  role: "police" | "collector" | "govt" | "cm";
  verified: boolean;
  source?: string;
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
  const rules: HandleRules = { state: { government: [], cm: [], police: [] }, districts: {} };
  for (const e of entries(root!.state, "state")) {
    if (!e.verified) continue;
    if (e.role === "govt") rules.state.government.push(bare(e));
    else if (e.role === "cm") rules.state.cm.push(bare(e));
    else if (e.role === "police") rules.state.police.push(bare(e));
  }
  if (root!.districts !== undefined && (typeof root!.districts !== "object" || Array.isArray(root!.districts))) fail("districts must be an object keyed by district");
  for (const [name, list] of Object.entries(root!.districts ?? {})) {
    if (name.startsWith("_")) continue;
    const d = { police: [] as string[], collector: [] as string[] };
    for (const e of entries(list, `districts.${name}`)) {
      if (e.verified && (e.role === "police" || e.role === "collector")) d[e.role].push(bare(e));
    }
    rules.districts[districtKey(name)] = d;
  }
  return rules;
}

// ─── Which handles a story gets ──────────────────────────────────────────────
//
// Party/election news, a leader's own post and news outside Rajasthan tag nobody. Otherwise, at most `max`:
//   - the CM, when the headline names him;
//   - the people and organisations the story is about (subject-handles.json), headline first;
//   - the district police / collector, only when the story names them as acting ("पुलिस ने", "थाना पुलिस कर
//     रही तलाश", "कलेक्टर ने", "जिला प्रशासन ने", "कलेक्टर की अध्यक्षता"): crime words alone tag nobody;
//   - Rajasthan Police HQ when the headline names it; the state government on its own decisions.
// A handle picked from the headline goes before one picked from the points.

const PARTY = /भाजपा|बीजेपी|कांग्रेस|प्रत्याशी|उम्मीदवार|जनसंपर्क|चुनाव\s*प्रचार|चुनावी|पंचायत\s*चुनाव|पंचायतीराज\s*चुनाव|सरपंच\s*चुनाव|मतदान|नामांकन|रैली|प्रदेशाध्यक्ष|पीसीसी|\bBJP\b|\bCongress\b|\bINC\b/iu;
/** The government deciding: "राज्य सरकार ने", "...का फैसला", "...के आदेश"; not "राज्य सरकार के खिलाफ धरना" */
const GOVT_ACTS = String.raw`\s*(?:ने|(?:का|की|के)\s*(?:बड़ा\s*|बड़ी\s*|बड़े\s*|नई\s*|नया\s*)?(?:फैसला|फैसले|निर्णय|आदेश|निर्देश|योजना|घोषणा|मंजूरी|पहल|अधिसूचना))`;
const GOVT = new RegExp(String.raw`(?:राज्य|प्रदेश)\s*सरकार${GOVT_ACTS}|सरकार\s*का\s*(?:बड़ा\s*)?फैसला|सरकार\s*ने\s*(?:जारी|लिया|दी|किया)|कैबिनेट|मंत्रिमंडल|अधिसूचना\s*जारी|आदेश\s*जारी|भजनलाल\s*सरकार`, "u");
const CM_SUBJECT = /(?:मुख्यमंत्री|सीएम|CM)\s*(?:श्री\s*)?भजनलाल|भजनलाल\s*शर्मा/u;
const POLICE_HQ = /पुलिस\s*मुख्यालय|डीजीपी|\bDGP\b|राजस्थान\s*पुलिस/gu;
const DGP = /डीजीपी|DGP/u;

type Agent = "police" | "collector";

const folded = (words: string[]) => new Set(words.map(fold));
/** One-word titles of the district police and the collector */
const AGENT_WORDS = new Map<string, Agent>([
  ...[
    "थानाधिकारी", "थानाप्रभारी", "एसएचओ", "SHO", "एसपी", "SP", "एएसपी", "ASP", "डीएसपी", "DSP", "डीसीपी", "DCP", "एडीसीपी", "ADCP", "सीओ", "कोतवाल",
    "सीआई", "CI", "एसआई", "SI", "एएसआई", "ASI", "डीएसटी", "DST",
  ].map(
    (w) => [fold(w), "police"] as [string, Agent],
  ),
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

/**
 * Which of the district police and the collector the text names as acting, clause by clause. `elsewhere` says a
 * word names another district: "बूंदी SP ने" in a Jaipur story is not Jaipur's police.
 */
export function actingAgents(text: string, elsewhere: (word: string) => boolean = () => false): Set<Agent> {
  const out = new Set<Agent>();
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
      // "सवाई माधोपुर एसपी", "बूंदी जिले के एसपी", "बूंदी जिला पुलिस")
      let k = i - 1;
      if (POSSESSIVE.has(t[k] ?? "") && DISTRICT_WORD.has(t[k - 1] ?? "")) k -= 2;
      else if (DISTRICT_WORD.has(t[k] ?? "")) k -= 1;
      const place = (t[k] !== undefined && elsewhere(t[k]!)) || (k >= 1 && elsewhere(`${t[k - 1]} ${t[k]}`));
      const notOurs = FORMER.has(t[i - 1] ?? "") || OTHER_FORCE.has(t[i - 1] ?? "") || place;
      if (!notOurs && actsAt(t, j, kinds.has("police"))) for (const k of kinds) out.add(k);
      i = Math.max(j, i + 1);
    }
  }
  return out;
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

export interface HandlePickInput {
  headline: string;
  points: string[];
  district: string | null;
  rajasthan: boolean;
  leaderPost: boolean;
  /** Whether a word names a district other than the story's (from the places file); none: never */
  elsewhere?: (word: string) => boolean;
}

export interface HandlePick {
  handle: string;
  /** Why: shown on the draft as the suggestion's entity */
  reason: "cm" | "police" | "collector" | "government" | "state_police" | "subject";
  /** The subject's title from subject-handles.json (reason "subject") */
  title?: string;
}

/** 0–2 verified handles for the post, headline picks first. */
export function pickHandles(story: HandlePickInput, rules: HandleRules, subjects: SubjectRules = EMPTY_SUBJECT_RULES, max = 2): HandlePick[] {
  // A leader's own post, party/election news, and news outside Rajasthan tag nobody
  if (story.leaderPost || !story.rajasthan) return [];
  const head = story.headline.normalize("NFC");
  const body = story.points.join("\n").normalize("NFC");
  if (PARTY.test(`${head}\n${body}`)) return [];

  const picks: (HandlePick & { inHeadline: boolean })[] = [];
  const add = (handles: string[] | undefined, reason: HandlePick["reason"], inHeadline: boolean, title?: string) => {
    // One handle per use is enough: the first verified one
    const h = handles?.[0];
    if (h) picks.push({ handle: h, reason, inHeadline, ...(title && { title }) });
  };
  const local = story.district ? rules.districts[districtKey(story.district)] : undefined;

  // The CM is the subject only when the headline names him
  if (CM_SUBJECT.test(head)) add(rules.state.cm, "cm", true);
  if (subjects.count) {
    const found = (text: string) => {
      const acting = actingSubjects(text, subjects);
      return subjects.gazetteer.find(text).filter((m) => !ONLY_ACTING.has(m.entry.data.kind) || acting.has(m.entry.id)).sort((a, b) => a.start - b.start);
    };
    const inHead = found(head);
    const named = new Set(inHead.map((m) => m.entry.id));
    const inBody = found(body).filter((m) => !named.has(m.entry.id));
    for (const m of inHead) add([m.entry.data.handle], "subject", true, m.entry.data.title);
    for (const m of inBody) add([m.entry.data.handle], "subject", false, m.entry.data.title);
  }
  const headActs = actingAgents(head, story.elsewhere);
  const bodyActs = actingAgents(body, story.elsewhere);
  if (headActs.has("police") || bodyActs.has("police")) add(local?.police, "police", headActs.has("police"));
  if (policeHqActs(head)) add(rules.state.police, "state_police", true);
  if (headActs.has("collector") || bodyActs.has("collector")) add(local?.collector, "collector", headActs.has("collector"));
  if (GOVT.test(head)) add(rules.state.government, "government", true);
  else if (GOVT.test(body)) add(rules.state.government, "government", false);

  // Headline picks first (stable), one per handle, at most max
  const out: HandlePick[] = [];
  for (const { inHeadline: _, ...p } of [...picks.filter((p) => p.inHeadline), ...picks.filter((p) => !p.inHeadline)]) {
    if (out.length >= max) break;
    if (!out.some((o) => o.handle.toLowerCase() === p.handle.toLowerCase())) out.push(p);
  }
  return out;
}
