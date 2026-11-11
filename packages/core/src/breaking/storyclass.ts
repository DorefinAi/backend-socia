// What KIND of story this is — the decision every handle rule hangs off.
//
// WHY THIS FILE EXISTS: the old code asked "is the police the grammatical actor?" Both that and the
// question before it ("does the copy contain an incident word?") are proxies for the question the desk
// answers first: *what sort of story is this?* Measured against 1,002 published posts (@1stIndiaNews:
// 602 from 9–10 Nov 2026, Diwali week, and 400 from 30 Oct 2026, a panchayat polling day), the class
// predicts the whole tag shape — how many handles, which roles, and whether our own reporter goes last:
//
//   class            tags the desk used                                    reporter rode along
//   incident         district police, almost always ALONE (248 of 302)      14.6%
//   administration   district collector, almost always ALONE (101 of 117)    6.0%
//   political        leader(s) + party + reporter — the 3/4-handle shape    54–67%
//   government       department or state govt + reporter                    63.8%
//   judicial         the reporter and NO institution (16 of 22 posts)        73%
//   soft             NOBODY — 19.9% of everything published                  n/a
//
// ─── TWO RULES THAT COST 30% ACCURACY WHEN THEY WERE WRONG ───────────────────
//
// 1. THE HEADLINE DECIDES. The first version of this file tested its word lists against headline and body
//    together and lost 31 political posts to the body: during Diwali week half of them mention मंदिर or
//    पूजा somewhere below the fold, so "मुख्यमंत्री भजनलाल शर्मा जैसलमेर दौरे पर" classified as devotional
//    copy and tagged nobody. The body is consulted ONLY when the headline says nothing.
//
// 2. GUARDS HAVE TO BE MEASURED, NOT REASONED. An earlier version suppressed near-miss accidents
//    ("बाल-बाल बचे", "हादसा टल गया") on the argument that an accident that did not happen is not a police
//    matter. In the window the desk tagged district police on 4 of those 5 posts. The guard was removed.
//    Kept, because the data agrees with them: "कांटे की टक्कर" (a close contest) and the consumer
//    commission (1 post, tagged nobody).

import { fold } from "../fold";

export type StoryClass =
  | "leader_post"
  | "incident"
  | "administration"
  | "political"
  | "government"
  | "judicial"
  | "soft"
  | "other";

/**
 * A word list compiled for matching. Single words are matched as whole TOKENS; anything containing a
 * space is matched as a PHRASE against the folded text.
 *
 * This split is not cosmetic: an earlier version put "मुख्य सचिव", "राज्य सरकार", "जिला प्रशासन" and
 * "हाई कोर्ट" into token sets, where a two-word entry can never match a one-word token, so every
 * multi-word rule in the file was dead. It cost 16 government posts on its own.
 */
interface WordSet {
  tokens: ReadonlySet<string>;
  phrases: readonly string[];
}
const folded = (words: readonly string[]): WordSet => {
  const f = words.map(fold).filter(Boolean);
  return { tokens: new Set(f.filter((w) => !w.includes(" "))), phrases: f.filter((w) => w.includes(" ")) };
};

// ─── soft copy: the 19.9% that tags nobody ───────────────────────────────────
//
// Derived, not invented: the words whose presence most strongly predicted ZERO handles, against a 19.9%
// base rate — श्रद्धालुओं 5/5, भव्य 5/5, भगवान 6/7, अर्पित 6/7, महोत्सव 5/6, अन्नकूट 6/9, पूजा 23/38,
// गोवर्धन 18/31.
//
// SEASONAL WARNING: one window is Diwali week, so गोवर्धन / अन्नकूट / पूजा are over-represented and this
// cluster will be smaller in March. The CATEGORY generalises — devotional and ceremonial copy tags
// nobody — the exact words should be re-measured each quarter.
const DEVOTIONAL = folded([
  "पूजा", "पूजन", "अर्चना", "महायज्ञ", "यज्ञ", "अन्नकूट", "गोवर्धन", "श्रद्धालु", "श्रद्धालुओं", "दर्शन", "आरती",
  "भगवान", "महाराज", "मंदिर", "धाम", "श्रीनाथजी", "महोत्सव", "मेला", "मेले", "जुलूस", "शोभायात्रा", "अर्पित",
  "प्रतिमा", "गौशाला", "गौमाता", "परंपरा", "भंडारा", "कीर्तन", "सत्संग", "भव्य", "बाबा", "जयंती",
]);
/**
 * Obituaries and condolence copy. 37 posts carried these words; 10 tagged nobody but 18 tagged a
 * politician — a leader's condolence message is political copy. So MOURNING is checked AFTER the
 * political test, and only a death notice with no leader in it reaches `soft`.
 */
const MOURNING = folded(["निधन", "शोक", "श्रद्धांजलि", "दिवंगत", "पार्थिव", "अंत्येष्टि"]);
/**
 * Quiz and puzzle formats only: "बूझो तो जानें ?".
 *
 * `गपशप` and `गॉसिप` were here and had to come out. A gossip column is tagged BY SUBJECT, not left
 * untagged: "सियासी गपशप" tagged a politician, and "ब्यूरोक्रेटिक गपशप" / "एम्पलॉई गॉसिप" tagged
 * @RajGovOfficial on four separate posts. Only a genuine puzzle tags nobody.
 */
const COLUMN = folded(["बूझो", "पहेली"]);
/**
 * Result bulletins. 30 posts on the held-out day were bare panchayat results — "पंचायत समिति का पहला
 * परिणाम जारी", "ग्राम पंचायत ढांगा और रामपुरा खारा का परिणाम जारी" — and the desk tagged nobody on
 * every one. Of 23 posts across both days carrying a result word, 18 tagged nobody.
 */
const ELECTION_RESULT = folded([
  "सरपंच परिणाम", "मतगणना", "निर्वाचित घोषित", "जीत दर्ज", "निर्वाचित", "मतों से", "पद पर हुईं", "पद पर हुई",
]);
/**
 * Result words that are only an ELECTION result in an election's company. The copy writes
 * "परिणाम हुआ जारी" and "मतदान हुआ संपन्न" as often as the tight form, so these have to be single
 * tokens — but "परिणाम", and even "परिणाम जारी", also means an exam or recruitment result, and on its
 * own it sent "आरपीएससी ने जारी किया परिणाम" (tagged @RPSC1) and board results to the untagged pile.
 */
const RESULT_WORD = folded(["परिणाम", "संपन्न", "रिजल्ट", "नतीजे", "विजेता", "विजयी"]);
/** What makes a result an election result */
const ELECTION_WORD = folded([
  "चुनाव", "मतदान", "निर्वाचन", "सरपंच", "पंचायत", "पंच", "वार्ड", "प्रधान", "जिला परिषद", "उपचुनाव", "मतपत्र", "मतगणना", "प्रत्याशी", "उम्मीदवार",
]);
/**
 * Election MACHINERY, which is not the same thing as a campaign. "पुनर्मतदान के आदेश", "चुनाव ड्यूटी रिपीट",
 * "ग्रामीणों ने किया चुनाव का बहिष्कार" — process stories, tagged nobody. A leader canvassing is
 * `political` and gets tagged. Conflating the two is what made the old single PARTY regex wrong in both
 * directions at once.
 *
 * "बहिष्कार" alone is deliberately absent: it means any boycott, and on its own it sent a municipal
 * strike to this rule.
 */
const ELECTION_PROCESS = folded([
  "पुनर्मतदान", "मतदान दल", "चुनाव ड्यूटी", "मतदान केंद्र", "चुनाव बहिष्कार", "मतदान बहिष्कार", "नामांकन वापसी", "रेसला",
  "आदर्श आचार संहिता", "निर्वाचन विभाग",
]);

// ─── judicial: the reporter, and no institution ──────────────────────────────
//
// 22 posts mentioned a court, bail, a petition or a hearing. 16 tagged our reporter and nothing else, 4
// tagged nobody, 2 tagged an institution. So a court story does NOT tag the police even when the copy is
// full of आरोपी and जमानत — which is exactly how "राजस्थान हाईकोर्ट में फर्जी जमानत आदेश अपलोड करने के
// मामले में बड़ी कार्रवाई" was mis-tagged as an incident before this class existed.
const JUDICIAL = folded([
  "हाईकोर्ट", "हाई कोर्ट", "सुप्रीम कोर्ट", "अदालत", "कोर्ट", "न्यायालय", "जमानत", "याचिका", "सुनवाई",
  "अधिकरण", "ट्रिब्यूनल", "उपभोक्ता आयोग", "हर्जाना", "सीजेएम", "एडीजे", "लोक अदालत",
]);

// ─── incident: the district police story ─────────────────────────────────────
export const INCIDENT_WORDS: readonly string[] = [
  // crime
  "हत्या", "हत्याकांड", "कत्ल", "चाकूबाजी", "फायरिंग", "गोलीबारी", "गोली", "लूट", "लूटपाट", "डकैती", "चोरी",
  "नकबजनी", "सेंधमारी", "गिरफ्तार", "गिरफ्तारी", "आरोपी", "बदमाश", "बदमाशों", "तस्करी", "तस्कर", "दुष्कर्म",
  "अपहरण", "हमला", "हमले", "हमलों", "हमलावर", "वारदात", "शव", "लाश", "फरार", "अवैध", "छीना", "उत्पात",
  "आतंक", "जानलेवा", "गैंगरेप", "छेड़छाड़", "दर्ज", "बरामद", "स्मैक", "गिरोह",
  // brawls and public disorder — 17 of 20 posts carrying these tagged district police
  "झगड़ा", "हाथापाई", "मारपीट", "लाठी", "डंडे", "बवाल", "पथराव", "तोड़फोड़", "हंगामा", "फायर",
  // fire, accident, emergency. "गोदाम में लगी आग" tagged police on every occurrence in the window.
  "हादसा", "हादसे", "दुर्घटना", "टक्कर", "भिड़ंत", "पलटी", "पलटा", "कुचला", "घायल", "आग", "आगजनी", "झुलसे",
  "झुलसा", "डूबने", "डूबा", "दमकल", "ब्लास्ट", "धमाका", "विस्फोट", "बेकाबू", "मौत", "मृत्यु", "लापता",
  // routine police-beat activity. Not an incident in the ordinary sense, but the desk tags the district
  // police on it: traffic enforcement, checking drives, patrols ahead of a poll.
  "चेकिंग", "नाकाबंदी", "गश्त", "चालान", "यातायात", "ट्रैफिक", "दबिश", "छापा", "छापेमारी",
  // bribery and traps: the Bhilwara घूसकांड case the old list missed entirely
  "घूस", "घूसकांड", "रिश्वत", "रिश्वतखोरी", "ट्रैप", "एसीबी",
  // Deliberately NOT here: धोखाधड़ी / ठगी / जालसाजी alone. In the window these split between police
  // stories and consumer-commission or court rulings; JUDICIAL now catches the second kind, and when the
  // police really are acting the acting-agent path in handles.ts still tags them.
];
const INCIDENT = new Set(INCIDENT_WORDS.map(fold));

/**
 * Phrases that look like an incident and are not.
 *
 * REMOVED after measurement: "बाल-बाल बचे" and "हादसा टल गया". An earlier patch suppressed near misses;
 * the desk tagged district police on 4 of the 5 such posts in the window. Reasoning lost to counting.
 *
 * "आंधी" deserves its own warning: it is a TOWN in Jaipur Rural, not a storm, and a weather word list
 * that includes it will tag @JprRuralPolice on the forecast.
 */
const NOT_INCIDENT = [
  "कांटे की टक्कर", "कड़ी टक्कर", "टक्कर देंगे", "टक्कर देगी", "टक्कर देगा", "टक्कर दे रहे", "टक्कर दे रही",
  "सीधी टक्कर", "अवैध संबंध", "आग की तरह", "आग उगल", "मौत का कुआं",
  // A VERBAL attack. "X पर बोला हमला" is a daily political headline, and with "हमला" in the list above it
  // was classifying as a crime — so a party row tagged the district police, alone, which is the one
  // pairing the corpus never shows (no party tag ever stood beside a police handle).
  "बोला हमला", "हमला बोला", "हमला बोल", "हमलावर हुए", "साधा निशाना", "निशाना साधा", "जुबानी हमला", "पलटवार",
  // "दर्ज" is in the list above for "मामला दर्ज" (a case registered). These are the other readings: a win
  // recorded, an objection filed, rainfall measured. Without them a bare panchayat result bulletin — the
  // copy the desk tags NOBODY on — tagged the district police.
  "जीत दर्ज", "दर्ज की जीत", "विरोध दर्ज", "आपत्ति दर्ज", "एतराज दर्ज", "बारिश दर्ज", "तापमान दर्ज", "दर्ज की गई बढ़ोतरी",
].map(fold);

// ─── political ───────────────────────────────────────────────────────────────
const POLITICAL = folded([
  "मुख्यमंत्री", "उपमुख्यमंत्री", "सीएम", "राज्यपाल", "मंत्री", "राज्यमंत्री", "विधायक", "सांसद", "प्रतिपक्ष",
  "प्रदेशाध्यक्ष", "कांग्रेस", "भाजपा", "बीजेपी", "प्रत्याशी", "उम्मीदवार", "जनसंपर्क", "प्रचार", "रैली",
  "पार्टी कार्यकर्ता", "दौरा", "दौरे", "मुलाकात", "शुभकामनाएं", "पीसीसी", "सभापति", "महापौर", "लोकसभा",
  "विधानसभा", "सियासी", "नेता", "नेताओं",
  // The desk mixes scripts in file headlines — "CM Bhajanlal Sharma का दीपावली दरबार", "Sonia Gandhi की
  // किताब". A Devanagari-only list misses those entirely.
  "CM", "Congress", "BJP", "INC", "Bhajanlal", "Gehlot", "Sonia Gandhi", "Rahul Gandhi", "Modi", "MLA",
  "Minister", "Governor",
]);
// NOTE: "कार्यकर्ता" on its own is deliberately absent. It means "worker" or "activist" generally, and it
// classified "सामाजिक कार्यकर्ता संजीत बंकर रॉय का निधन" — an obituary the desk tagged nobody on — as
// political copy.

// ─── administration: officers rank high, bodies rank low ─────────────────────
//
// This split is the single biggest generalisation fix in the file, and the held-out corpus is what
// forced it. On a polling day the copy is full of पंचायत समिति and ग्राम पंचायत, and a single ADMIN
// list tagged a collector on all of it — including 30 bare result bulletins the desk tagged NOBODY on.
//
// What separates them is whether an OFFICER is named. "SDM-ERO रजत विजयवर्गीय ने जारी किया मतदान बुलेटिन"
// and "जिला निर्वाचन अधिकारी डॉ.आर्तिका शुक्ला ने संभाला मोर्चा" tag the collector; "पंचायत समिति रेवदर
// सरपंच परिणाम" tags nobody. So an officer word classifies as administration BEFORE the soft rules get a
// look, and a bare administrative body only after them. 26.5% → 58.0% administration recall.

/** A named office acting. Ranks above the soft rules — an officer in the copy is a collector tag. */
const ADMIN_OFFICER = folded([
  "कलेक्टर", "कलक्टर", "जिला कलेक्टर", "जिलाधिकारी", "डीएम", "जिला प्रशासन", "एसडीएम", "तहसीलदार",
  "उपखंड अधिकारी", "निर्वाचन अधिकारी", "निर्वाचन आयुक्त", "रिटर्निंग अधिकारी", "ईआरओ", "ERO", "SDM", "DM",
  "एडीएम", "सीईओ", "जिला परिषद",
]);
/** An administrative body with nobody named. Ranks below the soft rules. */
const ADMIN_BODY = folded([
  "नगरपालिका", "नगर परिषद", "नगर निगम", "पंचायत समिति", "ग्राम पंचायत", "वार्ड", "सरपंच",
  "उपखंड", "पंचायतीराज", "पंचायती राज", "बूथ", "मतदाता",
]);

// ─── government: state administration, departments, state schemes ────────────
//
// What @RajGovOfficial was ACTUALLY tagged on in all 83 of its posts — the secretariat, state
// commissions, government employees and state-run services. A beat, not a fallback.
const GOVERNMENT = folded([
  "मुख्य सचिव", "सचिवालय", "शासन सचिव", "राज्य सरकार", "प्रदेश सरकार", "कैबिनेट", "मंत्रिमंडल", "अधिसूचना",
  "आयोग", "विभाग", "कर्मचारी", "कर्मचारियों", "सरकारी", "पेंशनर", "पेंशनरों", "योजना", "अनुदान",
  "काउंसलिंग", "भर्ती", "स्थानांतरण", "तबादला", "प्रदूषण", "वायु", "रेलवे", "बोर्ड", "प्राधिकरण",
  // a commissioner, a municipal corporation, the development authority, a new train service, the
  // bureaucracy beat
  "आयुक्त", "निगम", "जेडीए", "JDA", "रेलसेवा", "अधिशासी", "संभागीय", "अतिक्रमण",
  "ब्यूरोक्रेटिक", "आईएएस", "IAS", "आरएएस", "RAS", "आईपीएस", "IPS", "आला अधिकारी", "रिटायर्ड",
  "सेवानिवृत्त", "प्रतिनियुक्ति", "एपीओ", "APO", "जेपीसी", "JPC",
  // Police HEADQUARTERS (not a district force) is state administration: "DGP ने ली अधिकारियों की बैठक"
  // tagged @PoliceRajasthan. Safe to put here because `incident` is tested first, so a crime story that
  // mentions the DGP is still a crime story.
  "डीजीपी", "DGP", "पुलिस मुख्यालय",
]);
// WEATHER IS DELIBERATELY ABSENT. मौसम / तूफान / चक्रवात were here after the held-out day showed a
// cyclone story tagging a department. Counted across both days, 24 weather posts tagged nobody 14 times,
// a collector 6 and a department 3 — so the majority answer is "no tag", and a weather rule in this list
// would tag @IMDJaipur on two-thirds of them wrongly. Let weather fall through to `other`.

/**
 * Splits folded text into tokens.
 *
 * fold() already turns punctuation into spaces, so this is mostly a whitespace split — but it is written
 * to split on punctuation too, because the rule it protects is easy to lose: "युवक की हत्या, पेट में"
 * must not yield the token "हत्या," with the comma attached. On a corpus whose folding did not strip
 * punctuation that bug silently cost 21 incident posts.
 */
const tokens = (f: string): string[] => f.split(/[\s,।॥;:!?|()"'‘’“”\-–—.]+/u).filter(Boolean);

/** Whether the folded text hits a word set, by token or by phrase. */
const hits = (f: string, words: string[], set: WordSet) => words.some((w) => set.tokens.has(w)) || set.phrases.some((p) => f.includes(p));
const phrase = (f: string, list: readonly string[]) => list.some((p) => f.includes(p));

/**
 * Incident words that are only sometimes about a crime. "हमला" is an attack, and also what every leader
 * does to the other side daily ("सरकार पर हमला"); "दर्ज" is a case registered, and also a win, an
 * objection or a rainfall figure. On their own they are not enough to overrule a political signal — and
 * when they did, a party row tagged the district police, alone, which is the one pairing 1,002 published
 * posts never show. A real crime word beside them still wins, so "विधायक के घर चोरी" stays a police story.
 */
const WEAK_INCIDENT = new Set(["हमला", "हमले", "हमलों", "दर्ज"].map(fold));

/** Whether the copy reports a crime, fire or accident, and whether it says so in its own right. */
export function incidentStrength(text: string): "none" | "weak" | "strong" {
  const f = fold(text.normalize("NFC"));
  if (phrase(f, NOT_INCIDENT)) return "none";
  const words = tokens(f);
  if (hits(f, words, JUDICIAL)) return "none"; // a bail order is not a crime report
  const found = words.filter((w) => INCIDENT.has(w));
  if (found.some((w) => !WEAK_INCIDENT.has(w)) || phrase(f, [fold("लगी आग"), fold("जिंदा जलाने")])) return "strong";
  return found.length ? "weak" : "none";
}

/** Whether this copy reports a crime, fire or accident: an incident word with nothing that undoes it. */
export function isIncident(text: string): boolean {
  return incidentStrength(text) !== "none";
}

export interface ClassifyInput {
  headline: string;
  points: string[];
  /** A leader's own post, quoted verbatim — tags nobody at all */
  leaderPost: boolean;
  /**
   * Whether a person or party the directory knows is named in the headline. Devanagari has no
   * capitalisation, so "अशोक गहलोत" carries no orthographic cue and no title word — without this hint a
   * headline that is nothing but a leader's name reads as having no political signal at all.
   * Measured: political recall 92.5% with the hint, 84.4% without.
   */
  namedPolitical?: boolean;
}

export interface Classification {
  cls: StoryClass;
  /** Why, for the draft's audit line. The desk should be able to read this and agree or disagree. */
  why: string;
}

/**
 * One text's class, or null when it carries no signal. Precedence is measured, not assumed:
 *
 *   column → judicial → incident → admin officer → election result → political
 *          → mourning → devotional → election process → admin body → government
 *
 * `judicial` outranks `incident` because court copy is full of आरोपी and जमानत and the desk tags no
 * police on it. `election result` outranks `political` because a bulletin that names the winner is still
 * a bulletin (worth 7 posts on the held-out day). `political` outranks `mourning` and `devotional`
 * because a leader's condolence message or temple visit is political copy — 18 of 37 mourning posts
 * tagged a politician; A/B tested at 73.8% against 72.4%. `incident` outranks `political` because
 * "विधायक के घर चोरी" is a police story; that costs the handful of posts where a leader comments on an
 * accident, and it is the cheaper of the two errors.
 */
function decide(text: string, namedPolitical: boolean): Classification | null {
  const f = fold(text.normalize("NFC"));
  const words = tokens(f);
  if (hits(f, words, COLUMN)) return { cls: "soft", why: "a column or light feature, not news" };
  if (hits(f, words, JUDICIAL)) return { cls: "judicial", why: "a court, a hearing or a commission ruling" };
  const political = namedPolitical || hits(f, words, POLITICAL);
  const incident = incidentStrength(text);
  // `incident` outranks `political` because "विधायक के घर चोरी" is a police story — but only on a real
  // crime word. A leader attacking the government is not an assault.
  if (incident === "strong" || (incident === "weak" && !political)) return { cls: "incident", why: "a crime, fire or accident" };
  if (hits(f, words, ADMIN_OFFICER)) return { cls: "administration", why: "a named officer of the district administration" };
  // Before the political test on purpose: "सरपंच रिजल्ट घोषित, उम्मीदवार बनवारी लाल 827 मतों से" names a
  // winner, and naming a winner does not make a bulletin a campaign story.
  if (hits(f, words, ELECTION_RESULT) || (hits(f, words, RESULT_WORD) && hits(f, words, ELECTION_WORD))) {
    return { cls: "soft", why: "an election result bulletin" };
  }
  if (political) return { cls: "political", why: "a named leader, party or campaign" };
  if (hits(f, words, MOURNING)) return { cls: "soft", why: "a death notice with no leader in it" };
  if (hits(f, words, DEVOTIONAL)) return { cls: "soft", why: "devotional or ceremonial copy" };
  if (hits(f, words, ELECTION_PROCESS)) return { cls: "soft", why: "election machinery, not a campaign" };
  if (hits(f, words, ADMIN_BODY)) return { cls: "administration", why: "an administrative body, nobody named" };
  if (hits(f, words, GOVERNMENT)) return { cls: "government", why: "state administration, a department or a scheme" };
  return null;
}

/**
 * The story's class. THE HEADLINE DECIDES: the body is consulted only when the headline carries no
 * signal at all. Testing both together cost 31 political posts to stray devotional words in the body —
 * see the note at the top of this file.
 */
export function classify(story: ClassifyInput): Classification {
  if (story.leaderPost) return { cls: "leader_post", why: "a leader's own post, quoted verbatim" };
  const named = story.namedPolitical === true;
  const fromHead = decide(story.headline, named);
  if (fromHead) return fromHead;
  const body = story.points.join("\n");
  const fromBody = decide(body, false);
  if (fromBody) return { cls: fromBody.cls, why: `${fromBody.why} (from the body; the headline was silent)` };
  return { cls: "other", why: "no class matched" };
}
