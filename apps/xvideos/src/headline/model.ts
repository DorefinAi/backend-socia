// Step 4: qwen3:14b (Ollama, think off, JSON) writes the headline, the place and topic hashtags from the screen text
// (README §4.2, 7). The prompt is the trial's (x_headline.py, trials 4-5, 27 Nov 2026) with two lines added: one for
// clips whose bar is all programme filler, one against headlines about the clip ("एंकर के अनुसार ...", seen on speech-only
// national clips on 27 Nov). The model never posts: what it writes is a suggestion on the desk; the place suffix,
// brand, #FINVideo and handles come from rules in step 5.

export const XV_HEADLINE_PROMPT = `तुम First India News (राजस्थान का हिंदी न्यूज़ चैनल) के डिजिटल डेस्क के एडिटर हो। TV बुलेटिन से कटे एक वीडियो को X पर पोस्ट करना है।
तुम वीडियो नहीं देख सकते। तुम्हें दो चीज़ें मिलेंगी: स्क्रीन से OCR से पढ़ा टेक्स्ट (समय के क्रम में), और एंकर की शुरुआती लाइनें।

## किस पर कितना भरोसा
- "हेडलाइन बार" की लाइनें: हेडलाइन का मुख्य स्रोत और वर्तनी (नाम, गाँव, शहर) का मुख्य स्रोत। बार 3-4 लाइनों में बदलती है।
- "बाकी स्क्रीन टेक्स्ट": BREAKING बॉक्स, पीला प्लेस स्लग (जैसे कोटा, निवाई से LIVE), नेम स्ट्रिप। टूटे शब्द और कचरा हो सकता है।
- हेडलाइन बार में कुछ न पढ़ा गया हो तो वीडियो की अपनी खबर (कौन, कहाँ, क्या हुआ) "बाकी स्क्रीन टेक्स्ट" में है; हेडलाइन उसी से बनाओ।
- एंकर की लाइनें: मशीन ट्रांसक्रिप्ट, वर्तनी अक्सर गलत, इसलिए उससे वर्तनी मत लो। इससे समझो कि लीड क्या है
  (एंकर "खबर ___ से है" के बाद जो पढ़ता है वही आम तौर पर लीड होती है)।

## हेडलाइन कैसे बनती है
- A: बार की एक लाइन जैसी है वैसी।
- B (सबसे आम): बार की दो लाइनें कॉमा से जोड़ो। पहला हिस्सा मुख्य घटना, दूसरा उसका सबसे अहम विवरण।
- C: बड़े सार्वजनिक कार्यक्रम में जगह + व्यक्ति का नाम + बार की लाइन।
- D: कई लाइनों को मिलाकर छोटा दोबारा लेखन।
- हर तथ्य स्क्रीन टेक्स्ट या एंकर की लाइनों में होना चाहिए। कोई नाम, जगह, संख्या या घटना अपनी तरफ़ से मत जोड़ो।
- हेडलाइन ख़बर की तरह लिखो। उसमें "एंकर", "स्क्रीन", "वीडियो में", "लीड", "स्पष्ट नहीं" जैसी बातें कभी मत लिखो; बात साफ़ न हो तो
  जो कहा या दिखाया गया उसकी सबसे ठोस बात (कौन, क्या बोला या क्या हुआ) हेडलाइन बनाओ।
- लंबाई 50-130 अक्षर। हिंदी (देवनागरी) में; बड़े नेताओं/जगहों/संस्थाओं के नाम अंग्रेज़ी में लिखो
  (PM Narendra Modi, Ashok Gehlot, Om Birla, SMS Hospital, STF, JDA, Jaipur Airport, Bansur Cylinder Blast)।
- ज़रूरत हो तभी विषय का प्रीफ़िक्स (Accident:, Panchayat Election Result:)।
- हेडलाइन में "| ... News" मत लिखो; वह अलग से जुड़ता है।

## जगह
- place_hindi: स्लग या बार में लिखी जगह, जैसी लिखी है।
- district_english: वह जगह Rajasthan के किस ज़िले में है (जैसे सरिस्का -> Alwar, खेतड़ी -> Jhunjhunu, वनस्थली -> Tonk)। बाहर की हो या पता न हो तो खाली।
- state_english: राज्य। पूरे राज्य की राजनीति हो तो district खाली और state "Rajasthan"।

## टॉपिक hashtags
अंग्रेज़ी CamelCase, 2 से 7: लोग (#AshokGehlot), घटना या शहर के अंदर की जगह (#GasTankerLeakage, #JaipurAirport), अपराध/हादसे का बीट (#JaipurAccident)।
ब्रांड टैग, #FINVideo, शहर का टैग और #RajasthanNews मत दो; वे अलग से जुड़ते हैं।

## पहले की असली हेडलाइन (सिर्फ़ शैली के लिए; इनके तथ्य मत लेना)
- रींगस के भेरुजी मोड़ से सरकारी अस्पताल चौराहे तक लगा लंबा जाम, सैंकड़ों वाहन फंसे
- Gas Tanker Leakage: भामटसर में गैस टैंकर में रिसाव, 2 दमकल मौके पर लेकिन बेअसर
- अनियंत्रित होकर सर्विस लाइन में जा घुसा ट्रोला, हादसे में 1 की मौत, करीब आधा दर्जन लोगों के घायल होने की सूचना
- JDA इंस्पेक्टर ललित कुमार पारीक को हाईकोर्ट से बड़ी राहत, 2019 का दोषसिद्धि आदेश निरस्त
- 3 दिवसीय ऋषि मेले का आज से आगाज, गुजरात राज्यपाल Acharya Devvrat का सम्बोधन
- कथा वाचक जया किशोरी पहुंची कोलकाता से जयपुर एयरपोर्ट
- मानसरोवर थाना इलाके की घटना, उधार दिए रुपये मांगे तो पार्टी ने भेज दिए नकली नोट
- Rajasthan में कृषि भूमि के गैर-कृषि उपयोग के लिए नए नियम लागू

## हेडलाइन बार (समय के क्रम में)
{bar}

## बाकी स्क्रीन टेक्स्ट
{other}

## एंकर की शुरुआती लाइनें
{speech}

सिर्फ़ यह JSON लौटाओ:
{"place_hindi": "", "district_english": "", "state_english": "", "headline": "...", "topic_hashtags": ["#..."]}`;

/** The prompt for one clip: its bar lines (programme filler dropped), other screen text and, if read, the anchor's words */
export function xvHeadlinePrompt(bar: readonly string[], other: readonly string[], speech: string): string {
  const parts: Record<string, string> = {
    bar: bar.join("\n") || "(कुछ नहीं पढ़ा गया)",
    other: other.join("\n") || "(कुछ नहीं)",
    speech: speech.trim() || "(नहीं है)",
  };
  // One pass, so screen text that happens to hold "{other}" is never filled in again
  return XV_HEADLINE_PROMPT.replace(/\{(bar|other|speech)\}/g, (_m, k: string) => parts[k]!);
}

/** The model's answer, checked */
export interface XvModelAnswer {
  headline: string;
  placeHindi: string;
  district: string;
  state: string;
  topicHashtags: string[];
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The model's JSON → the answer; no headline (or not JSON) is an error, so the try counts and is retried */
export function xvParseModelAnswer(content: string): XvModelAnswer {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error(`the model did not answer in JSON: ${content.slice(0, 120)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the model's answer is not a JSON object");
  // A "|" at the end is the suffix the prompt asks it to leave out
  const headline = text(raw.headline).replace(/\|+\s*$/, "").trim();
  if (!headline) throw new Error("the model wrote no headline");
  const tags = Array.isArray(raw.topic_hashtags) ? raw.topic_hashtags : [];
  const topicHashtags = [...new Set(tags.map(text).filter((t) => /^#\w+$/u.test(t)))].slice(0, 7);
  return { headline, placeHindi: text(raw.place_hindi), district: text(raw.district_english), state: text(raw.state_english), topicHashtags };
}

/** Longer than this is not a headline (the prompt asks for 50-130 letters) */
const MAX_HEADLINE = 200;
/** Words of a headline about the clip instead of the news ("एंकर के अनुसार ... स्पष्ट नहीं", 27 Nov speech-only clips) */
// ("स्क्रीनिंग" and "वायरल वीडियो में" are news, so only the screen as the clip's own is matched)
const ABOUT_THE_CLIP = /एंकर|स्क्रीन पर|स्क्रीन से|स्पष्ट नहीं|संभव नहीं|पहचान करना/;

/**
 * Why a headline is not worth offering, or null when it is: it talks about the anchor or the clip rather than the news,
 * or it runs far past a headline's length. The desk then shows no suggestion (the editor writes one).
 */
export function xvHeadlineProblem(headline: string): string | null {
  if (ABOUT_THE_CLIP.test(headline)) return "about the clip, not the news";
  if ([...headline].length > MAX_HEADLINE) return `longer than ${MAX_HEADLINE} letters`;
  return null;
}

/** Ollama is not running or the model is not pulled: the clip waits, no try used */
export class XvModelDown extends Error {
  constructor(reason: string) {
    super(`The headline model is not answering (${reason}).`);
    this.name = "XvModelDown";
  }
}

/** One answer takes 1-3 s on the RTX 4090; this long means Ollama is stuck */
const MODEL_TIMEOUT_MS = 5 * 60_000;

export interface XvModelReply {
  content: string;
  tokensOut: number | null;
  tookS: number;
  /** think=false was not honoured (the answer came with thinking) */
  thought: boolean;
}

export class XvModelClient {
  constructor(
    private readonly baseUrl: string,
    readonly model: string,
  ) {}

  async ask(prompt: string): Promise<XvModelReply> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          format: "json",
          keep_alive: "15m",
          options: { temperature: 0.2, num_ctx: 8192, num_predict: 400 },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") throw new Error(`the model did not answer in ${MODEL_TIMEOUT_MS / 60_000} min`);
      throw new XvModelDown((err as Error).message);
    }
    let body: { message?: { content?: unknown; thinking?: unknown }; eval_count?: unknown; error?: unknown; done_reason?: unknown } | null;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // 404: the model is not pulled (setup.ps1 pulls it), whatever the body
      if (res.status === 404) throw new XvModelDown(`status 404`);
      throw new Error(`the model answered ${res.status} without JSON`);
    }
    const error = typeof body?.error === "string" ? body.error : `status ${res.status}`;
    if (res.status === 404) throw new XvModelDown(error);
    if (!res.ok) throw new Error(`the model failed: ${error}`);
    const content = body?.message?.content;
    if (typeof content !== "string") throw new Error("the model's reply has no message");
    // Cut off at num_predict: the JSON is unfinished, so say so rather than "not JSON"
    if (body?.done_reason === "length") throw new Error("the model's answer was cut off (num_predict)");
    return {
      content,
      tokensOut: typeof body?.eval_count === "number" ? body.eval_count : null,
      tookS: Math.round((Date.now() - started) / 10) / 100,
      thought: typeof body?.message?.thinking === "string" && body.message.thinking.length > 0,
    };
  }
}
