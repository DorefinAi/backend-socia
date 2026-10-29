// Local development only: a dummy Samvadia and a dummy FTP footage tree, and the Socia org + logins.
// Never points at a real system: it refuses any database not on localhost, and refuses Samvadia's own
// databases (samvadia, samvadia_preview) outright.
//
//   corepack pnpm local:dev samvadia-seed    ADMIN_DATABASE_URL=<local postgres superuser> must be set
//                                            in the shell (not in .env). Creates socia_samvadia_dummy, a
//                                            read-only login for Socia and an owner login for this script,
//                                            ~30 approved stories, and the footage tree under FOOTAGE_DIR.
//   corepack pnpm local:dev samvadia-late    A story approved "now", a late file in an existing folder, and
//                                            a footage path filled in for a story that had none.
//   corepack pnpm local:dev socia-setup      Org, an admin and an operator login (local.credentials.md),
//                                            fixed #RajasthanWithFirstIndia, district and topic hashtag rules;
//                                            writes ORG_ID into .env.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, hashtagRules, orgs, users, type OrgSettings } from "@socia/db";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { hashPassword } from "../src/auth";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENV_FILE = join(ROOT, ".env");
const CREDENTIALS_FILE = join(ROOT, "local.credentials.md");
const DUMMY_DB = "socia_samvadia_dummy";
const RO_ROLE = "socia_samvadia_ro";
const OWNER_ROLE = "socia_samvadia_dummy";
const FORBIDDEN_DBS = new Set(["samvadia", "samvadia_preview", "samvadia_test"]);

const placeholders = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/placeholders.json"), "utf8")) as { jpg: string[]; png: string[] };

// ─── Guards and .env ─────────────────────────────────────────────────────────

function localOnly(url: string, what: string): URL {
  const u = new URL(url);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) throw new Error(`${what} must be on localhost (got ${u.hostname})`);
  const db = decodeURIComponent(u.pathname.slice(1));
  if (FORBIDDEN_DBS.has(db)) throw new Error(`${what} points at Samvadia's own database "${db}". Use ${DUMMY_DB}.`);
  return u;
}

async function setEnv(values: Record<string, string>): Promise<void> {
  const lines = existsSync(ENV_FILE) ? (await readFile(ENV_FILE, "utf8")).split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  await writeFile(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"));
}

const secret = (n = 18) => randomBytes(n).toString("base64url");
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

// ─── The dummy newsroom ──────────────────────────────────────────────────────

interface District {
  code: string;
  name: string;
  hi: string;
  folder: (d: Date, slug: string) => string;
}

const dd = (d: Date) => String(d.getDate()).padStart(2, "0");
const mm = (d: Date) => String(d.getMonth() + 1).padStart(2, "0");
const yy = (d: Date) => String(d.getFullYear()).slice(2);
const MON = (d: Date) => d.toLocaleString("en", { month: "short" }).toUpperCase();
const mon = (d: Date) => d.toLocaleString("en", { month: "short" }).toLowerCase();

// Real-looking layouts, one per district, as the bureaus actually name them
const DISTRICTS: Record<string, District> = {
  AJM: { code: "AJM", name: "Ajmer", hi: "अजमेर", folder: (d, s) => `/Ajmer/${d.getFullYear()}/${MON(d)} ${d.getFullYear()}/${dd(d)}${mm(d)}${yy(d)}/${s}` },
  BRN: { code: "BRN", name: "Baran", hi: "बारां", folder: (d, s) => `/BARAN/${mon(d)}${d.getFullYear()}/${dd(d)}${mm(d)}${d.getFullYear()}/${s}` },
  JPR: { code: "JPR", name: "Jaipur", hi: "जयपुर", folder: (d, s) => `/Jaipur/${d.getFullYear()}/${MON(d)} ${d.getFullYear()}/${dd(d)}-${mm(d)}-${d.getFullYear()}/${s}` },
  KOT: { code: "KOT", name: "Kota", hi: "कोटा", folder: (d, s) => `/Kota/${MON(d)} ${d.getFullYear()}/${dd(d)}${mm(d)}${d.getFullYear()}/${s}` },
  UDR: { code: "UDR", name: "Udaipur", hi: "उदयपुर", folder: (d, s) => `/Udaipur/${d.getFullYear()}/${dd(d)}${mm(d)}${yy(d)}/${s}` },
  JDH: { code: "JDH", name: "Jodhpur", hi: "जोधपुर", folder: (d, s) => `/JODHPUR/${mon(d)}${d.getFullYear()}/${dd(d)}${mm(d)}${d.getFullYear()}/${s}` },
  BKN: { code: "BKN", name: "Bikaner", hi: "बीकानेर", folder: (d, s) => `/BIKANER/${d.getFullYear()}/${MON(d)}/${dd(d)}${mm(d)}${yy(d)}/${s}` },
  ALW: { code: "ALW", name: "Alwar", hi: "अलवर", folder: (d, s) => `/ALWER/${mon(d)} ${d.getFullYear()}/${dd(d)}${mm(d)}${d.getFullYear()}/${s}` },
  BHL: { code: "BHL", name: "Bhilwara", hi: "भीलवाड़ा", folder: (d, s) => `/Bhilwara/${d.getFullYear()}/${MON(d)} ${d.getFullYear()}/${dd(d)}${mm(d)}${yy(d)}/${s}` },
  SKR: { code: "SKR", name: "Sikar", hi: "सीकर", folder: (d, s) => `/Sikar/${mon(d)}${d.getFullYear()}/${dd(d)}${mm(d)}${d.getFullYear()}/${s}` },
};

/** Files in a story folder: j = photos, p = png graphic, v = video, s = video in a VISUALS subfolder,
 *  x = an .xml sidecar (ignored), d = a .docx (not a media type), b = a 6 MB photo (over a 5 MB cap),
 *  "-" = Samvadia has not found the footage yet (footage_path is null) */
interface Seed {
  d: string;
  subject: string;
  type: string;
  reporter: string;
  reporterHi: string;
  headline: string;
  body: string;
  files: string;
  itemKind?: string;
  /** Samvadia's item priority; "breaking" also makes the feed title "FLASH <slug>". Unset: HIGH below, else normal */
  priority?: "breaking" | "high";
}

const SEEDS: Seed[] = [
  { d: "AJM", subject: "HADSA", type: "AV", reporter: "SHUBHAM", reporterHi: "शुभम शर्मा", files: "jjv", priority: "breaking",
    headline: "अजमेर-जयपुर हाईवे पर बस और ट्रक की भिड़ंत, 12 यात्री घायल",
    body: "किशनगढ़ के पास तड़के हुए हादसे में रोडवेज बस और ट्रक आमने-सामने टकरा गए। घायलों को जेएलएन अस्पताल में भर्ती कराया गया है, जहां दो की हालत गंभीर है। पुलिस ने मामला दर्ज कर जांच शुरू कर दी है।" },
  { d: "AJM", subject: "PUSHKARMELA", type: "PKG", reporter: "RAVI", reporterHi: "रवि सेन", files: "jjjv",
    headline: "पुष्कर मेले की तैयारियां अंतिम चरण में, ऊंटों की आवक शुरू",
    body: "अंतरराष्ट्रीय पुष्कर मेले के लिए मेला मैदान में पशुपालकों का पहुंचना शुरू हो गया है। प्रशासन ने सुरक्षा के लिए 40 सीसीटीवी कैमरे लगाए हैं और श्रद्धालुओं के लिए अतिरिक्त बसें चलाई जाएंगी।" },
  { d: "AJM", subject: "DARGAH", type: "VO", reporter: "SHUBHAM", reporterHi: "शुभम शर्मा", files: "j",
    headline: "ख्वाजा साहब की दरगाह में जायरीन के लिए नई कतार व्यवस्था",
    body: "दरगाह कमेटी ने भीड़ को देखते हुए जायरीन के लिए अलग प्रवेश और निकास द्वार तय किए हैं। जुमे की नमाज के दौरान अतिरिक्त पुलिस बल तैनात रहेगा।" },
  { d: "BRN", subject: "DHAN", type: "AV", reporter: "MUKESH", reporterHi: "मुकेश मीणा", files: "jjv",
    headline: "बारां मंडी में धान की बंपर आवक, किसानों को मिले अच्छे दाम",
    body: "कृषि उपज मंडी में मंगलवार को धान की करीब 60 हजार बोरियों की आवक हुई। व्यापारियों के अनुसार इस बार गुणवत्ता अच्छी होने से किसानों को पिछले साल से बेहतर भाव मिल रहे हैं।" },
  { d: "BRN", subject: "SAHARIYA", type: "PKG", reporter: "MUKESH", reporterHi: "मुकेश मीणा", files: "jjs",
    headline: "शाहबाद में सहरिया परिवारों को मिले पक्के मकान की चाबियां",
    body: "प्रधानमंत्री आवास योजना के तहत शाहबाद क्षेत्र के 150 सहरिया परिवारों को पक्के मकान सौंपे गए। जिला कलेक्टर ने लाभार्थियों से बातचीत कर उनकी समस्याएं सुनीं।" },
  { d: "BRN", subject: "BARISH", type: "VO", reporter: "DEEPAK", reporterHi: "दीपक नागर", files: "-",
    headline: "बेमौसम बारिश से बारां में सोयाबीन की फसल को नुकसान",
    body: "जिले में बीती रात हुई तेज बारिश से खेतों में कटी पड़ी सोयाबीन की फसल भीग गई। किसानों ने प्रशासन से गिरदावरी कराकर मुआवजे की मांग की है।" },
  { d: "JPR", subject: "METRO", type: "AV", reporter: "ANKIT", reporterHi: "अंकित जैन", files: "jjpv", priority: "breaking",
    headline: "जयपुर मेट्रो फेज-2 की डीपीआर को मंजूरी, सीतापुरा से अंबाबाड़ी तक बनेगा रूट",
    body: "मुख्यमंत्री भजनलाल शर्मा की अध्यक्षता में हुई बैठक में मेट्रो फेज-2 की डीपीआर को मंजूरी दी गई। करीब 42 किलोमीटर लंबे रूट पर 36 स्टेशन बनाए जाएंगे।" },
  // First India's own sample post (28 Oct 2026): a long body, so the draft shows the "...." cut
  { d: "JPR", subject: "HIGHCOURT", type: "AV", reporter: "SONAL", reporterHi: "सोनल गुप्ता", files: "j", priority: "breaking",
    headline: "राजस्थान हाईकोर्ट का SI भर्ती-2016 को लेकर बड़ा निर्णय",
    body: "50% आरक्षण सीमा के अनुसार पदों की होगी पुनर्गणना के आदेश, 90 दिन में पदों की पुनर्गणना कर संशोधित सूची जारी करने के आदेश दिए गए हैं। कोर्ट ने कहा कि भर्ती प्रक्रिया में आरक्षण के नियमों का पालन जरूरी है और राज्य सरकार को तय समय में पालना रिपोर्ट पेश करनी होगी। याचिकाकर्ताओं की ओर से वरिष्ठ अधिवक्ता ने पैरवी की।" },
  { d: "JPR", subject: "TRAFFIC", type: "VO", reporter: "ANKIT", reporterHi: "अंकित जैन", files: "jj",
    headline: "दिवाली की खरीदारी में परकोटे में जाम, ट्रैफिक पुलिस ने बदले रूट",
    body: "त्योहारी भीड़ के चलते चारदीवारी के बाजारों में वाहनों का प्रवेश शाम 4 बजे से रात 10 बजे तक बंद रहेगा। पार्किंग के लिए रामनिवास बाग और चौगान स्टेडियम में व्यवस्था की गई है।" },
  { d: "JPR", subject: "DENGUE", type: "PKG", reporter: "SONAL", reporterHi: "सोनल गुप्ता", files: "jv",
    headline: "जयपुर में डेंगू के मामले 900 पार, स्वास्थ्य विभाग ने चलाया सर्वे अभियान",
    body: "शहर में डेंगू के बढ़ते मामलों को देखते हुए स्वास्थ्य विभाग की 200 टीमें घर-घर सर्वे कर रही हैं। लोगों से कूलर और गमलों में पानी जमा न होने देने की अपील की गई है।" },
  { d: "JPR", subject: "SMS", type: "BYTE", reporter: "SONAL", reporterHi: "सोनल गुप्ता", files: "pj",
    headline: "एसएमएस अस्पताल में नया ट्रॉमा वार्ड शुरू, 60 बेड की सुविधा",
    body: "सवाई मानसिंह अस्पताल में आधुनिक उपकरणों से लैस नया ट्रॉमा वार्ड शुरू किया गया। इससे गंभीर घायलों को तुरंत इलाज मिल सकेगा।" },
  { d: "KOT", subject: "COACHING", type: "AV", reporter: "RAHUL", reporterHi: "राहुल वर्मा", files: "jjv",
    headline: "कोटा में कोचिंग छात्रों के लिए हेल्पलाइन अब 24 घंटे चलेगी",
    body: "जिला प्रशासन ने कोचिंग छात्रों की काउंसलिंग के लिए हेल्पलाइन को चौबीसों घंटे चालू रखने का फैसला किया है। हॉस्टल संचालकों को भी नियमित बैठकें करने के निर्देश दिए गए हैं।" },
  { d: "KOT", subject: "CHAMBAL", type: "VO", reporter: "RAHUL", reporterHi: "राहुल वर्मा", files: "jjj",
    headline: "चंबल रिवरफ्रंट पर लाइट एंड साउंड शो का ट्रायल सफल",
    body: "चंबल रिवरफ्रंट पर देश के सबसे बड़े लाइट एंड साउंड शो का ट्रायल किया गया। नवंबर से पर्यटकों के लिए यह शो रोज शाम को होगा।" },
  { d: "KOT", subject: "CHORI", type: "AV", reporter: "PRIYA", reporterHi: "प्रिया हाड़ा", files: "bjv",
    headline: "कोटा में ज्वेलरी शोरूम से लाखों की चोरी, सीसीटीवी में कैद हुए आरोपी",
    body: "विज्ञान नगर इलाके में देर रात बदमाश शटर तोड़कर शोरूम में घुसे और गहने ले गए। पुलिस सीसीटीवी फुटेज के आधार पर आरोपियों की तलाश कर रही है।" },
  { d: "UDR", subject: "JHEEL", type: "PKG", reporter: "KAMAL", reporterHi: "कमल पालीवाल", files: "jjjj",
    headline: "उदयपुर की फतहसागर झील में नौकायन फिर शुरू",
    body: "मानसून के बाद सुरक्षा जांच पूरी होने पर फतहसागर झील में नौकायन दोबारा शुरू कर दिया गया है। पर्यटकों के लिए लाइफ जैकेट अनिवार्य की गई है।" },
  { d: "UDR", subject: "PARYATAN", type: "VO", reporter: "KAMAL", reporterHi: "कमल पालीवाल", files: "jx",
    headline: "दिवाली की छुट्टियों में उदयपुर पहुंचे रिकॉर्ड सैलानी, होटल फुल",
    body: "दिवाली की छुट्टियों में झीलों की नगरी में देशी-विदेशी पर्यटकों की भारी भीड़ है। शहर के ज्यादातर होटल अगले हफ्ते तक बुक हो चुके हैं।" },
  { d: "UDR", subject: "TENDUA", type: "AV", reporter: "NEHA", reporterHi: "नेहा चौहान", files: "js",
    headline: "गोगुंदा क्षेत्र में तेंदुए का मूवमेंट, वन विभाग ने लगाया पिंजरा",
    body: "गोगुंदा के पास गांवों में तेंदुए के दिखने से ग्रामीणों में दहशत है। वन विभाग ने दो जगह पिंजरे लगाए हैं और लोगों से रात में अकेले बाहर न निकलने को कहा है।" },
  { d: "JDH", subject: "AIRPORT", type: "AV", reporter: "VIKAS", reporterHi: "विकास बिश्नोई", files: "jj",
    headline: "जोधपुर से बेंगलुरु के लिए सीधी उड़ान 1 नवंबर से",
    body: "जोधपुर एयरपोर्ट से बेंगलुरु के लिए रोजाना सीधी उड़ान शुरू होगी। इससे पश्चिमी राजस्थान के यात्रियों को दक्षिण भारत जाने में सुविधा होगी।" },
  { d: "JDH", subject: "MEHRANGARH", type: "VO", reporter: "VIKAS", reporterHi: "विकास बिश्नोई", files: "jjv",
    headline: "मेहरानगढ़ किले में अंतरराष्ट्रीय लोक संगीत उत्सव की तैयारी",
    body: "मेहरानगढ़ में होने वाले लोक संगीत उत्सव में 15 देशों के कलाकार हिस्सा लेंगे। आयोजकों ने बताया कि टिकटों की ऑनलाइन बिक्री शुरू हो गई है।" },
  { d: "JDH", subject: "PANI", type: "PKG", reporter: "SUNITA", reporterHi: "सुनीता राठौड़", files: "d",
    headline: "जोधपुर के कई इलाकों में दो दिन पानी की सप्लाई बंद रहेगी",
    body: "जलदाय विभाग मुख्य पाइपलाइन की मरम्मत करेगा, इसलिए शहर के करीब 20 इलाकों में गुरुवार और शुक्रवार को पानी नहीं आएगा। टैंकरों से आपूर्ति की व्यवस्था की गई है।" },
  { d: "BKN", subject: "CAMEL", type: "AV", reporter: "ARJUN", reporterHi: "अर्जुन चारण", files: "jj",
    headline: "बीकानेर में ऊंटनी के दूध से बनी मिठाइयों की मांग बढ़ी",
    body: "राष्ट्रीय उष्ट्र अनुसंधान केंद्र में बनी ऊंटनी के दूध की मिठाइयों की दिवाली पर खूब मांग है। केंद्र ने इस बार उत्पादन दोगुना किया है।" },
  { d: "BKN", subject: "BSF", type: "VO", reporter: "ARJUN", reporterHi: "अर्जुन चारण", files: "jv",
    headline: "बीकानेर सीमा पर बीएसएफ ने ड्रोन से गिराई गई हेरोइन जब्त की",
    body: "खाजूवाला सेक्टर में बीएसएफ के जवानों ने सर्च ऑपरेशन के दौरान दो पैकेट हेरोइन बरामद की। माना जा रहा है कि इसे पाकिस्तान की ओर से ड्रोन से गिराया गया था।" },
  { d: "ALW", subject: "SARISKA", type: "AV", reporter: "MANOJ", reporterHi: "मनोज यादव", files: "jjjv",
    headline: "सरिस्का में बाघिन एसटी-12 ने दिए तीन शावक",
    body: "सरिस्का टाइगर रिजर्व में बाघिन एसटी-12 को तीन शावकों के साथ कैमरा ट्रैप में देखा गया। इसके साथ ही रिजर्व में बाघों की संख्या 45 हो गई है।" },
  { d: "ALW", subject: "BHIWADI", type: "PKG", reporter: "MANOJ", reporterHi: "मनोज यादव", files: "jx",
    headline: "भिवाड़ी में प्रदूषण बढ़ा, एक्यूआई 300 के पार",
    body: "औद्योगिक नगरी भिवाड़ी में हवा की गुणवत्ता लगातार खराब हो रही है। प्रदूषण नियंत्रण मंडल ने निर्माण कार्यों पर अस्थायी रोक लगाने के निर्देश दिए हैं।" },
  { d: "BHL", subject: "TEXTILE", type: "AV", reporter: "GOPAL", reporterHi: "गोपाल जाट", files: "jj",
    headline: "भीलवाड़ा के कपड़ा उद्योग को दिवाली पर 500 करोड़ के ऑर्डर",
    body: "वस्त्र नगरी भीलवाड़ा की मिलों में इन दिनों तीन पारियों में काम चल रहा है। उद्यमियों के अनुसार इस साल निर्यात के ऑर्डर भी बढ़े हैं।" },
  { d: "BHL", subject: "SCHOOL", type: "VO", reporter: "GOPAL", reporterHi: "गोपाल जाट", files: "j",
    headline: "",
    body: "भीलवाड़ा के एक सरकारी स्कूल में कक्षा की छत का प्लास्टर गिरा, छुट्टी होने से बड़ा हादसा टल गया। शिक्षा विभाग ने जर्जर भवनों का सर्वे कराने के आदेश दिए हैं।" },
  { d: "SKR", subject: "KHATU", type: "AV", reporter: "SANDEEP", reporterHi: "संदीप सैनी", files: "jjv",
    headline: "खाटूश्यामजी में एकादशी पर उमड़े लाखों श्रद्धालु",
    body: "एकादशी पर बाबा श्याम के दर्शन के लिए देशभर से श्रद्धालु पहुंचे। मंदिर कमेटी ने दर्शन के लिए 14 कतारें बनाई और रींगस से पैदल यात्रियों के लिए विशेष इंतजाम किए।" },
  { d: "SKR", subject: "CHUNAV", type: "AV", reporter: "SANDEEP", reporterHi: "संदीप सैनी", files: "jj",
    headline: "सीकर में पंचायत चुनाव के लिए मतदान शुरू, सुबह से लगी कतारें",
    body: "जिले की 42 ग्राम पंचायतों में सरपंच और वार्ड पंच के लिए वोट डाले जा रहे हैं। निर्वाचन विभाग ने संवेदनशील बूथों पर अतिरिक्त जाब्ता लगाया है।" },
  { d: "SKR", subject: "SAINIK", type: "PKG", reporter: "SANDEEP", reporterHi: "संदीप सैनी", files: "jj",
    headline: "सीकर के लाल का पार्थिव शरीर पहुंचा गांव, नम आंखों से दी विदाई",
    body: "",
  },
];

// Samvadia's item priority and category, so the desk can colour the dummy stories
const HIGH = new Set(["CHORI", "BSF", "CHUNAV", "DENGUE", "BARISH"]);
const CATEGORY: Record<string, string> = {
  HADSA: "अपराध/Crime", CHORI: "अपराध/Crime", BSF: "अपराध/Crime", TRAFFIC: "अपराध/Crime",
  HIGHCOURT: "राजनीति/Politics", CHUNAV: "राजनीति/Politics", METRO: "राजनीति/Politics", PRESSNOTE: "राजनीति/Politics",
  DHAN: "कृषि/Agriculture", CAMEL: "कृषि/Agriculture", SAHARIYA: "कृषि/Agriculture",
  BARISH: "मौसम/Weather", BHIWADI: "मौसम/Weather",
  DENGUE: "स्वास्थ्य/Health", SMS: "स्वास्थ्य/Health",
};
const itemPriority = (s: Seed) => s.priority ?? (HIGH.has(s.subject) ? "high" : "normal");

const TODAY = new Date();
const ddmmyy = `${dd(TODAY)}${mm(TODAY)}${yy(TODAY)}`;
const slugOf = (s: Seed) => `${ddmmyy}_${s.d}_${s.subject}_${s.type}_${s.reporter}`;

function description(s: Seed, kind: string, replaces?: string): string {
  const city = DISTRICTS[s.d]!.hi;
  if (kind === "kill") return `((यह खबर रद्द है, प्रसारित न करें: ${replaces}))`;
  const parts = kind === "update" && replaces ? [`((पिछला संस्करण रद्द करें: ${replaces}))`] : [];
  parts.push(`${city}:`, s.body || "शहीद जवान को पूरे सैन्य सम्मान के साथ अंतिम विदाई दी गई। हजारों लोगों ने नम आंखों से श्रद्धांजलि दी।", `संवाददाता: ${s.reporterHi}, ${city} ब्यूरो`);
  return parts.join("\n\n");
}

function mp4(sizeKb = 8): Buffer {
  // An ftyp box and padding: enough for a file browser to call it MP4; not playable
  const head = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
  return Buffer.concat([head, Buffer.alloc(sizeKb * 1024)]);
}

async function writeFootage(root: string, folder: string, spec: string, slug: string): Promise<{ name: string; size: number; modified: string }[]> {
  const dir = join(root, ...folder.split("/").filter(Boolean));
  await mkdir(dir, { recursive: true });
  const out: { name: string; size: number; modified: string }[] = [];
  let photo = 0;
  const put = async (name: string, data: Buffer) => {
    const full = join(dir, ...name.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    out.push({ name, size: data.length, modified: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
  };
  for (const c of spec) {
    if (c === "j") await put(`${slug}_${String(++photo).padStart(2, "0")}.jpg`, Buffer.from(placeholders.jpg[(photo - 1) % placeholders.jpg.length]!, "base64"));
    if (c === "p") await put(`${slug}_GFX.png`, Buffer.from(placeholders.png[0]!, "base64"));
    if (c === "v") await put(`${slug}.mp4`, mp4());
    if (c === "s") await put(`VISUALS/${slug}_RAW.mp4`, mp4(16));
    if (c === "x") await put(`${slug}.xml`, Buffer.from(`<clip name="${slug}"/>`));
    if (c === "d") await put(`${slug}_SCRIPT.docx`, Buffer.from("PK placeholder"));
    if (c === "b") await put(`${slug}_HIRES.jpg`, Buffer.concat([Buffer.from(placeholders.jpg[0]!, "base64"), Buffer.alloc(6 * 1024 * 1024)]));
  }
  return out;
}

// ─── Commands ────────────────────────────────────────────────────────────────

const SCHEMA = `
  -- Only the tables and columns Socia reads (apps: packages/db/src/samvadia.ts SAMVADIA_COLUMNS)
  CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    headline TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    reporter_slug TEXT,
    district_code VARCHAR(8),
    kind VARCHAR(16) NOT NULL DEFAULT 'story' CHECK (kind IN ('story', 'press_release', 'day_plan', 'not_a_story')),
    footage_status VARCHAR(16) NOT NULL DEFAULT 'not_checked' CHECK (footage_status IN ('not_checked', 'waiting', 'found', 'not_found', 'manual')),
    footage_path TEXT,
    footage_files JSONB NOT NULL DEFAULT '[]'::jsonb,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'breaking')),
    category TEXT
  );
  CREATE TABLE stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('original', 'update', 'kill')),
    slug VARCHAR(96) NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    district TEXT NOT NULL,
    guid TEXT NOT NULL UNIQUE,
    state VARCHAR(16) NOT NULL CHECK (state IN ('waiting', 'ready')),
    published_at TIMESTAMPTZ,
    UNIQUE (item_id, version)
  );
  CREATE INDEX stories_feed_idx ON stories (state, published_at);
`;

async function insertStory(c: pg.Client, root: string, s: Seed, at: Date, opts: { itemKind?: string } = {}) {
  const district = DISTRICTS[s.d]!;
  const slug = slugOf(s);
  const path = s.files === "-" ? null : `${district.folder(TODAY, slug)}/`;
  const files = path ? await writeFootage(root, path, s.files, slug) : [];
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO items (headline, body, reporter_slug, district_code, kind, footage_status, footage_path, footage_files, priority, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING id`,
    [s.headline, s.body, s.reporter, s.d, opts.itemKind ?? "story", path ? "found" : "waiting", path, JSON.stringify(files), itemPriority(s), CATEGORY[s.subject] ?? null],
  );
  const itemId = rows[0]!.id;
  const storyId = randomUUID();
  await c.query(
    `INSERT INTO stories (id, item_id, version, kind, slug, title, description, district, guid, state, published_at)
     VALUES ($1, $2, 1, 'original', $3, $4, $5, $6, $7, 'ready', $8)`,
    [storyId, itemId, slug, s.priority === "breaking" ? `FLASH ${slug}` : slug, description(s, "original"), district.name, `vartmaan-${storyId}-v1`, at],
  );
  return { itemId, storyId, slug };
}

async function addVersion(c: pg.Client, itemId: string, s: Seed, version: number, kind: "update" | "kill", at: Date, changes: Partial<Seed> = {}) {
  const district = DISTRICTS[s.d]!;
  const slug = slugOf(s);
  const next = { ...s, ...changes };
  if (kind === "update") await c.query(`UPDATE items SET headline = $2, body = $3 WHERE id = $1`, [itemId, next.headline, next.body]);
  const id = randomUUID();
  await c.query(
    `INSERT INTO stories (id, item_id, version, kind, slug, title, description, district, guid, state, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ready', $10)`,
    [id, itemId, version, kind, slug, `${kind.toUpperCase()} ${slug}`, description(next, kind, slug), district.name, `vartmaan-${id}-v${version}`, at],
  );
}

async function samvadiaSeed(): Promise<void> {
  const admin = localOnly(need("ADMIN_DATABASE_URL"), "ADMIN_DATABASE_URL");
  const footageRoot = resolve(ROOT, need("FOOTAGE_DIR"));
  const roPassword = secret();
  const ownerPassword = secret();

  const su = new pg.Client({ connectionString: admin.toString() });
  await su.connect();
  try {
    await su.query(`DROP DATABASE IF EXISTS ${DUMMY_DB} WITH (FORCE)`);
    for (const [role, pw] of [[RO_ROLE, roPassword], [OWNER_ROLE, ownerPassword]] as const) {
      const exists = (await su.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount;
      // Passwords are set as a literal (no bind parameters in ALTER ROLE); both are url-safe base64
      await su.query(`${exists ? "ALTER" : "CREATE"} ROLE ${role} WITH LOGIN PASSWORD '${pw}'`);
    }
    await su.query(`CREATE DATABASE ${DUMMY_DB} OWNER ${OWNER_ROLE}`);
    // Like the live read-only login: every session of this role refuses writes
    await su.query(`ALTER ROLE ${RO_ROLE} SET default_transaction_read_only = on`);
  } finally {
    await su.end();
  }

  const ownerUrl = new URL(admin.toString());
  ownerUrl.username = OWNER_ROLE;
  ownerUrl.password = ownerPassword;
  ownerUrl.pathname = `/${DUMMY_DB}`;
  const roUrl = new URL(ownerUrl.toString());
  roUrl.username = RO_ROLE;
  roUrl.password = roPassword;

  const c = new pg.Client({ connectionString: ownerUrl.toString() });
  await c.connect();
  try {
    await c.query(SCHEMA);
    await c.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${RO_ROLE}; GRANT SELECT ON items, stories TO ${RO_ROLE};`);

    // Published over the last 3 hours, oldest first
    const start = Date.now() - 3 * 3600_000;
    const step = (3 * 3600_000) / (SEEDS.length + 6);
    const made: Record<string, { itemId: string }> = {};
    for (const [i, s] of SEEDS.entries()) made[slugOf(s)] = await insertStory(c, footageRoot, s, new Date(start + i * step));
    let t = start + SEEDS.length * step;
    const bySubject = (subj: string) => SEEDS.find((s) => s.subject === subj)!;
    // Two updates and a kill (the kill is not taken: it carries no text)
    await addVersion(c, made[slugOf(bySubject("DHAN"))]!.itemId, bySubject("DHAN"), 2, "update", new Date((t += step)), {
      headline: "बारां मंडी में धान की बंपर आवक, भाव 3100 रुपये प्रति क्विंटल तक पहुंचे",
    });
    await addVersion(c, made[slugOf(bySubject("METRO"))]!.itemId, bySubject("METRO"), 2, "update", new Date((t += step)), {
      body: "मुख्यमंत्री भजनलाल शर्मा की अध्यक्षता में हुई बैठक में मेट्रो फेज-2 की डीपीआर को मंजूरी दी गई। करीब 42 किलोमीटर लंबे रूट पर 36 स्टेशन बनेंगे और काम अगले साल मार्च से शुरू होगा।",
    });
    await addVersion(c, made[slugOf(bySubject("CHORI"))]!.itemId, bySubject("CHORI"), 2, "kill", new Date((t += step)));
    // A press release (taken) and a day plan (not taken)
    await insertStory(c, footageRoot, {
      d: "JPR", subject: "PRESSNOTE", type: "PR", reporter: "DESK", reporterHi: "डेस्क", files: "j",
      headline: "राज्य सरकार ने रबी की बुवाई के लिए किसानों को मुफ्त बीज किट देने की घोषणा की",
      body: "कृषि विभाग के अनुसार प्रदेश के 5 लाख किसानों को सरसों और चने की उन्नत बीज किट दी जाएंगी। आवेदन ई-मित्र केंद्रों पर किए जा सकेंगे।",
    }, new Date((t += step)), { itemKind: "press_release" });
    await insertStory(c, footageRoot, {
      d: "JPR", subject: "DAYPLAN", type: "DP", reporter: "DESK", reporterHi: "डेस्क", files: "-",
      headline: "आज का प्लान", body: "सुबह 10 बजे प्रेस वार्ता, दोपहर 2 बजे विधानसभा समिति की बैठक।",
    }, new Date((t += step)), { itemKind: "day_plan" });

    const { rows } = await c.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE s.kind <> 'kill' AND i.kind IN ('story','press_release'))::int AS takeable FROM stories s JOIN items i ON i.id = s.item_id`);
    console.log(`Dummy Samvadia ready: ${rows[0].n} stories (${rows[0].takeable} that Socia takes), footage under ${footageRoot}`);
    const mix = await c.query(`SELECT priority, count(*)::int AS n FROM items GROUP BY priority ORDER BY priority`);
    console.log(`Item priorities: ${mix.rows.map((r) => `${r.priority} ${r.n}`).join(", ")}`);
  } finally {
    await c.end();
  }

  await setEnv({ SAMVADIA_DATABASE_URL: roUrl.toString(), SAMVADIA_DUMMY_OWNER_URL: ownerUrl.toString() });
  console.log("Wrote SAMVADIA_DATABASE_URL (read-only login) and SAMVADIA_DUMMY_OWNER_URL to .env.");
}

async function samvadiaLate(): Promise<void> {
  const owner = localOnly(need("SAMVADIA_DUMMY_OWNER_URL"), "SAMVADIA_DUMMY_OWNER_URL");
  localOnly(need("SAMVADIA_DATABASE_URL"), "SAMVADIA_DATABASE_URL");
  if (decodeURIComponent(owner.pathname.slice(1)) !== DUMMY_DB) throw new Error(`samvadia-late only writes to ${DUMMY_DB}`);
  const footageRoot = resolve(ROOT, need("FOOTAGE_DIR"));
  const c = new pg.Client({ connectionString: owner.toString() });
  await c.connect();
  try {
    // 1. Footage found late for the story that had none
    const barish = SEEDS.find((s) => s.subject === "BARISH")!;
    const slug = slugOf(barish);
    const path = `${DISTRICTS.BRN!.folder(TODAY, slug)}/`;
    const files = await writeFootage(footageRoot, path, "jjv", slug);
    await c.query(`UPDATE items SET footage_path = $2, footage_status = 'found', footage_files = $3::jsonb WHERE id = (SELECT item_id FROM stories WHERE slug = $1 LIMIT 1)`, [slug, path, JSON.stringify(files)]);
    // 2. One more photo dropped late into an existing folder
    const camel = SEEDS.find((s) => s.subject === "CAMEL")!;
    const cslug = slugOf(camel);
    const cdir = join(footageRoot, ...DISTRICTS.BKN!.folder(TODAY, cslug).split("/").filter(Boolean));
    await writeFile(join(cdir, `${cslug}_LATE.jpg`), Buffer.from(placeholders.jpg[3]!, "base64"));
    // 3. A story approved just now
    const now = { d: "AJM", subject: `NEWS${Date.now() % 100000}`, type: "AV", reporter: "SHUBHAM", reporterHi: "शुभम शर्मा", files: "jv",
      headline: "अजमेर में नई सिटी बसों का संचालन शुरू, 20 रूट पर चलेंगी", body: "नगर निगम ने शहर में 25 नई इलेक्ट्रिक सिटी बसें शुरू की हैं। किराया 10 से 30 रुपये के बीच रहेगा।" };
    await insertStory(c, footageRoot, now, new Date());
    console.log(`Late footage for ${slug}, a late photo for ${cslug}, and a new story ${slugOf(now)}.`);
  } finally {
    await c.end();
  }
}

const FIXED_HASHTAGS = ["#RajasthanWithFirstIndia"];
const DEFAULT_SETTINGS: OrgSettings = { hashtagScript: "latin", fixedHashtags: FIXED_HASHTAGS, maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

// Topic tags for the post's tag line (matchType "entity"; places stay "district" and go in line 1)
const TOPICS: { name: string; aliases: string[]; tag: string; priority: number }[] = [
  { name: "हाईकोर्ट", aliases: ["हाई कोर्ट", "उच्च न्यायालय", "High Court"], tag: "RajasthanHighCourt", priority: 8 },
  { name: "चुनाव", aliases: ["इलेक्शन", "मतदान", "निर्वाचन", "Election"], tag: "RajasthanElection", priority: 7 },
  { name: "पुलिस", aliases: ["चोरी", "अपराध", "गिरफ्तार", "हत्या", "लूट", "Police"], tag: "RajasthanPolice", priority: 6 },
  { name: "मौसम", aliases: ["बारिश", "मानसून", "ओलावृष्टि", "Weather"], tag: "RajasthanWeather", priority: 5 },
  { name: "हादसा", aliases: ["हादसे", "दुर्घटना", "भिड़ंत", "Accident"], tag: "RoadAccident", priority: 6 },
];

async function sociaSetup(): Promise<void> {
  const url = need("DATABASE_URL");
  localOnly(url, "DATABASE_URL");
  const reset = process.argv.includes("--reset-passwords");
  const { db, close } = createDb(url, 1);
  try {
    let orgId = process.env.ORG_ID;
    const [found] = orgId ? await db.select().from(orgs).where(eq(orgs.id, orgId)) : [];
    if (!found) {
      const [org] = await db.insert(orgs).values({ name: "1st India News (local)", settings: DEFAULT_SETTINGS }).returning();
      orgId = org!.id;
      await setEnv({ ORG_ID: orgId });
      console.log("Created the org and wrote ORG_ID to .env.");
    } else if (found.settings.fixedHashtags.join(" ") !== FIXED_HASHTAGS.join(" ")) {
      await db.update(orgs).set({ settings: { ...found.settings, fixedHashtags: FIXED_HASHTAGS } }).where(eq(orgs.id, found.id));
      console.log(`Set the org's fixed hashtags to ${FIXED_HASHTAGS.join(" ")}.`);
    }

    const logins: { role: "admin" | "operator"; name: string; email: string; password: string | null }[] = [
      { role: "admin", name: "Local Admin", email: "admin@socia.local", password: null },
      { role: "operator", name: "Local Operator", email: "operator@socia.local", password: null },
    ];
    for (const l of logins) {
      const [u] = await db.select().from(users).where(eq(users.email, l.email));
      if (u && !reset) continue;
      l.password = secret(12);
      const passwordHash = await hashPassword(l.password);
      if (u) await db.update(users).set({ passwordHash, active: true }).where(eq(users.id, u.id));
      else await db.insert(users).values({ orgId: orgId!, name: l.name, email: l.email, role: l.role, platforms: ["x"], passwordHash });
    }

    for (const d of Object.values(DISTRICTS)) {
      const [r] = await db.select().from(hashtagRules).where(and(eq(hashtagRules.orgId, orgId!), eq(hashtagRules.name, d.hi)));
      if (!r) await db.insert(hashtagRules).values({ orgId: orgId!, matchType: "district", name: d.hi, aliases: [d.name], hashtagLatin: d.name, hashtagDevanagari: d.hi, priority: 5 });
    }
    for (const t of TOPICS) {
      const [r] = await db.select().from(hashtagRules).where(and(eq(hashtagRules.orgId, orgId!), eq(hashtagRules.name, t.name)));
      if (!r) await db.insert(hashtagRules).values({ orgId: orgId!, matchType: "entity", name: t.name, aliases: t.aliases, hashtagLatin: t.tag, hashtagDevanagari: null, priority: t.priority });
    }

    if (logins.some((l) => l.password)) {
      const prev = existsSync(CREDENTIALS_FILE) ? await readFile(CREDENTIALS_FILE, "utf8") : "";
      const keep = (email: string) => new RegExp(`\\| ${email.replace(/\./g, "\\.")} \\| ([^|]+) \\|`).exec(prev)?.[1]?.trim() ?? "(unchanged; run socia-setup --reset-passwords)";
      const rows = logins.map((l) => `| ${l.role} | ${l.email} | ${l.password ?? keep(l.email)} |`).join("\n");
      await writeFile(
        CREDENTIALS_FILE,
        `# Local test logins (gitignored; local only)\n\nAPI: http://localhost:${process.env.PORT ?? 8200} · desk: ${process.env.CORS_ORIGINS ?? "http://localhost:3005"}\nREQUIRE_TOTP=${process.env.REQUIRE_TOTP ?? "true"} locally, so sign-in is email + password only.\n\n| role | email | password |\n|---|---|---|\n${rows}\n`,
      );
      console.log(`Wrote the logins to ${CREDENTIALS_FILE}.`);
    }
    console.log(`Org ready, ${logins.length} logins, ${Object.keys(DISTRICTS).length} district and ${TOPICS.length} topic hashtag rules.`);
  } finally {
    await close();
  }
}

const command = process.argv[2];
const run: Record<string, () => Promise<void>> = { "samvadia-seed": samvadiaSeed, "samvadia-late": samvadiaLate, "socia-setup": sociaSetup };
if (!command || !run[command]) {
  console.log(`Commands: ${Object.keys(run).join(", ")}`);
  process.exitCode = 1;
} else {
  await run[command]!().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exitCode = 1;
  });
}
