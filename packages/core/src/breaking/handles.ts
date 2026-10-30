// Which official X accounts a breaking post tags: 0 to 2, chosen by rules, and only handles marked verified
// in the editable district-handles file (apps/worker/config/district-handles.json). A wrong government tag is
// a reputational incident, so every rule errs towards tagging nobody.

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

// Story kinds, from the words of the headline and points
const PARTY = /भाजपा|बीजेपी|कांग्रेस|प्रत्याशी|उम्मीदवार|जनसंपर्क|चुनाव\s*प्रचार|चुनावी|पंचायत\s*चुनाव|पंचायतीराज\s*चुनाव|सरपंच\s*चुनाव|मतदान|नामांकन|रैली|प्रदेशाध्यक्ष|पीसीसी|\bBJP\b|\bCongress\b|\bINC\b/iu;
const CRIME = /पुलिस|थाना|थाने|गिरफ्तार|हत्या|हत्याकांड|चोरी|लूट|डकैती|मुकदमा|आरोपी|बदमाश|हादसा|दुर्घटना|सड़क\s*हादसे|फायरिंग|चाकूबाजी|ठगी|तस्कर|तस्करी|अपहरण|दुष्कर्म|मारपीट|शव|खुदकुशी|आत्महत्या|नाकाबंदी|वारदात|जब्त/u;
const ADMIN = /कलेक्टर|कलक्टर|जिला\s*प्रशासन|जनसुनवाई|एसडीएम|\bSDM\b|उपखंड\s*अधिकारी|तहसीलदार|जिला\s*निर्वाचन|अतिक्रमण\s*हटा|धारा\s*163|स्कूलों\s*में\s*अवकाश|छुट्टी\s*घोषित/u;
const GOVT = /राज्य\s*सरकार\s*(?:ने|का|की|के)|सरकार\s*का\s*(?:बड़ा\s*)?फैसला|सरकार\s*ने\s*(?:जारी|लिया|दी|किया)|कैबिनेट|मंत्रिमंडल|अधिसूचना\s*जारी|आदेश\s*जारी|भजनलाल\s*सरकार|प्रदेश\s*सरकार\s*(?:ने|का|की)/u;
const CM_SUBJECT = /(?:मुख्यमंत्री|सीएम|CM)\s*(?:श्री\s*)?भजनलाल|भजनलाल\s*शर्मा/u;
const POLICE_HQ = /पुलिस\s*मुख्यालय|डीजीपी|\bDGP\b|राजस्थान\s*पुलिस/u;

export interface HandlePickInput {
  headline: string;
  points: string[];
  district: string | null;
  rajasthan: boolean;
  leaderPost: boolean;
}

export interface HandlePick {
  handle: string;
  /** Why: shown on the draft as the suggestion's entity */
  reason: "cm" | "police" | "collector" | "government" | "state_police";
}

/** 0–2 verified handles for the post, most specific first. */
export function pickHandles(story: HandlePickInput, rules: HandleRules, max = 2): HandlePick[] {
  // A leader's own post, party/election news, and news outside Rajasthan tag nobody
  if (story.leaderPost || !story.rajasthan) return [];
  const head = story.headline;
  const text = [head, ...story.points].join(" ");
  if (PARTY.test(text)) return [];

  const out: HandlePick[] = [];
  const add = (handles: string[] | undefined, reason: HandlePick["reason"]) => {
    // One handle per use is enough: the first verified one
    const h = handles?.[0];
    if (h && out.length < max && !out.some((p) => p.handle.toLowerCase() === h.toLowerCase())) out.push({ handle: h, reason });
  };
  const local = story.district ? rules.districts[districtKey(story.district)] : undefined;

  // The CM is the subject only when the headline names him
  if (CM_SUBJECT.test(head)) add(rules.state.cm, "cm");
  if (CRIME.test(text)) {
    add(local?.police, "police");
    if (POLICE_HQ.test(head)) add(rules.state.police, "state_police");
  }
  if (ADMIN.test(text)) add(local?.collector, "collector");
  if (GOVT.test(text)) add(rules.state.government, "government");
  return out;
}
