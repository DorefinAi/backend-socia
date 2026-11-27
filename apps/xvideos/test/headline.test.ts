// Step 4: the bar-line rules (programme filler A, programme name C) on the real reads of 27 Nov 2026, the prompt and the
// model's answer, which step comes next, and the headline role with its database and services mocked.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  xvClaimJob,
  xvDayScreens,
  xvDeferJob,
  xvFailJob,
  xvFinishJob,
  xvGetScreen,
  xvQueueMissingHeadlines,
  xvRedoStep,
  xvSaveHeadline,
  xvSaveScreenRead,
  xvSetProgress,
  type XvClaimedJob,
  type XvDayScreen,
} from "../src/db/clips";
import type { XvClipRow, XvScreenRead } from "../src/db/schema";
import { xvCleanLines, xvDayProgramme, xvLineKey, xvSimilarity } from "../src/headline/lines";
import { XvModelClient, XvModelDown, xvHeadlinePrompt, xvHeadlineProblem, xvParseModelAnswer } from "../src/headline/model";
import { XvHeadlineStep } from "../src/worker/headline";
import { XvMediaClient, XvMediaDown } from "../src/worker/read";
import { XvShareReader } from "../src/worker/share";
import { xvNextSteps } from "../src/worker/steps";

vi.mock("../src/db/clips", async (orig) => ({
  ...(await orig<typeof import("../src/db/clips")>()),
  xvClaimJob: vi.fn(),
  xvDayScreens: vi.fn(),
  xvDeferJob: vi.fn(),
  xvFailJob: vi.fn(),
  xvFinishJob: vi.fn(),
  xvGetScreen: vi.fn(),
  xvQueueMissingHeadlines: vi.fn(),
  xvRedoStep: vi.fn(),
  xvSaveHeadline: vi.fn(),
  xvSaveScreenRead: vi.fn(),
  xvSetProgress: vi.fn(),
}));

// Bar lines as the media service read them on 27 Nov 2026 (DAY2-RESULTS.md), OCR mistakes included
const PROGRAMME = [
  "गांव की 37 जिलों की 419 पंचायत समितियों में प्रधान का चुनाव",
  "गांव की प्रधान के लिए जोड़-तोड़ की गणित",
  "गांव की सुरक्षा के कड़े इंतजाम",
  "गांव की पचायत",
];
const DAY: Record<string, string[]> = {
  election1: ["गांव की प्रधान के लिए जोड-तोड की गणित", "गांव की सुरक्षा के कड़ इंतजाम", "गाव की पचायत", "गांव की 37 जिलों की 419 पंचायत समितियो में प्रधान का चनाव"],
  election2: ["गांव की सुरक्षा के कड़े इंतजाम", "गांव की 37 जिलों की 419 पचायत समितियों मे प्धान का चनाव", "गांव की पचायत", "गांव की प्रधान के लिए जोड़-तोडई की गणित"],
  election3: ["गांव की सरक्षा के कड़ इंतजाम", "गांव की 37 जिलों की 419 पचायत समितियों में प्रधान का चुनाव", "गांव की प्रधान के लिए जोड-तोड की गणित", "गांव की गांव की पचायत"],
  chandna: [
    "गांव की पंचायत",
    "विधायक अशोक चांदना पर पलिस अधिकारियों से बदसलकी के आरोप",
    "कहासनी के वायरल न वीडियो से हाड़ौती की सियासत में मची हलचल",
    ...PROGRAMME.slice(0, 3),
  ],
  amarsar: ["गांव की"],
  nabard1: ["cs वी. श्रीनिवास LIVE", "कॉन्टीक्यशन क्लब में नाबाई की ग्रामीण विकास कॉन्क्लेव", "मुख्य सचिव वी. श्रीनिवास नाबाई के ग्रामीण विकास कॉन्ले में शामिल"],
  nabard2: ["कॉन्टीक्यशन क्लब में नाबाई की ग्रामीण विकास कॉन्क्लेव", "मुख्य सचिव वी. श्रीनिवास नाबाई के ग्रामीण विकास कॉक्लेव में शामिल"],
  nabard3: ["ACCESS CONTROLLED LIFT-2", "कॉन्टीक्यशन क्लब में नाबाई की ग्रामीण विकास कॉन्क्लेव", "मुख्य सचिव वी. श्रीनिवास नाबाई के ग्रामीण विकास कॉक्लेव में शामिल"],
  tantrik: ["RPEAKINC NEAS", "प्राथमिक जांच में तांत्रिक क्रियाओं का मामला आया सामने", "बादिवाला श्मशान घाट में अज्ञात शव जलाने का मामला"],
  raid: ["RPEAKINC NEAS", "DEAZINe NEAS", "स्पेशल पलिस कमिश्नर ओम प्रकाश के निर्देशनमें बड़ी कार्रवा्ड"],
  accident: ["RPEAKINC NEAS", "RDEaKiNIC NEAS"],
};
const reads = Object.entries(DAY).map(([clipId, lines]) => ({ clipId, lines }));

describe("bar lines: the day's programme (fixes A and C)", () => {
  it("measures likeness as Python's difflib does (values from SequenceMatcher(None, a, b).ratio())", () => {
    expect(xvSimilarity("abcd", "abcd")).toBe(1);
    expect(xvSimilarity("abcd", "bcde")).toBeCloseTo(0.75);
    expect(xvSimilarity("", "")).toBe(1);
    expect(xvSimilarity("abc", "")).toBe(0);
    expect(xvSimilarity("abxcd", "abcd")).toBeCloseTo(0.888889, 5);
    expect(xvSimilarity("गांव की पंचायत", "गाव की पचायत")).toBeCloseTo(0.923077, 5);
    expect(xvSimilarity("जयपुर में भीषण हादसा", "जयपर में भीषण सडक हादसा")).toBeCloseTo(0.883721, 5);
    expect(xvSimilarity("rpeakinc neas", "breaking news")).toBeCloseTo(0.769231, 5);
    expect(xvSimilarity("gas tanker leakage", "breaking news")).toBeCloseTo(0.387097, 5);
  });

  it("compares lines without the marks OCR drops", () => {
    expect(xvLineKey("गाँंव  की")).toBe(xvLineKey("गाव की"));
    expect(xvLineKey("कड़े")).toBe(xvLineKey("कडे"));
  });

  it("finds the programme's name from the repeated lines", () => {
    expect(xvDayProgramme(reads).prefixes).toEqual([["गाव", "की"]]);
  });

  it("drops the programme's lines, keeps the clip's own, cuts the name", () => {
    const p = xvDayProgramme(reads);
    expect(xvCleanLines(DAY.election1!, p)).toEqual({ kept: [], dropped: DAY.election1 });
    expect(xvCleanLines(DAY.election3!, p).kept).toEqual([]);
    expect(xvCleanLines(DAY.chandna!, p).kept).toEqual(DAY.chandna!.slice(1, 3));
    expect(xvCleanLines(DAY.amarsar!, p).kept).toEqual([]);
    expect(xvCleanLines(["गांव की भाजपा के जयकिशन भादु बने निर्विरोध प्रधान"], p).kept).toEqual(["भाजपा के जयकिशन भादु बने निर्विरोध प्रधान"]);
  });

  it("keeps a story copied onto 3 clips: its lines start with different words", () => {
    const p = xvDayProgramme(reads);
    expect(xvCleanLines(DAY.nabard2!, p).kept).toEqual(DAY.nabard2);
    expect(xvCleanLines(DAY.nabard3!, p).kept).toEqual(DAY.nabard3);
  });

  it("drops the BREAKING NEWS logo read as text on 3+ clips", () => {
    const p = xvDayProgramme(reads);
    expect(xvCleanLines(DAY.tantrik!, p).kept).toEqual(DAY.tantrik!.slice(1));
    expect(xvCleanLines(DAY.accident!, p).kept).toEqual([]);
  });

  it("drops the logo misread on any clip, keeps real English bar lines", () => {
    const none = xvDayProgramme([]);
    expect(xvCleanLines(["RDEaKiNIC NEAS", "DDEAZINC NIEAS", "GAS TANKER LEAKAGE", "ACCESS CONTROLLED LIFT-2"], none).kept).toEqual(["GAS TANKER LEAKAGE", "ACCESS CONTROLLED LIFT-2"]);
    // An English line repeated on 3 clips (one story copied) stays too
    const copied = ["GAS TANKER LEAKAGE AT BHAMATSAR", "दूसरी लाइन यहाँ है"];
    const p = xvDayProgramme(["a", "b", "c"].map((clipId) => ({ clipId, lines: copied })));
    expect(xvCleanLines(copied, p).kept).toEqual(copied);
  });

  it("one shared word is not a programme's name", () => {
    const repeated = ["राजस्थान में बारिश का अलर्ट जारी", "राजस्थान के किसानों को राहत का ऐलान", "राजस्थान पुलिस की बड़ी कार्रवाई जारी"];
    const p = xvDayProgramme(["a", "b", "c"].map((clipId) => ({ clipId, lines: repeated })));
    expect(p.prefixes).toEqual([]);
    expect(xvCleanLines(repeated, p).kept).toEqual(repeated);
  });

  it("drops nothing on a day without a programme or with fewer than 3 clips", () => {
    const two = xvDayProgramme([reads[0]!, reads[1]!]);
    expect(two).toEqual({ filler: [], prefixes: [] });
    expect(xvCleanLines(DAY.election1!, two).kept).toEqual(DAY.election1);
  });
});

describe("the model's prompt and answer", () => {
  it("fills the prompt once, with placeholders for what is missing", () => {
    const p = xvHeadlinePrompt(["line one {other}"], [], "");
    expect(p).toContain("line one {other}\n");
    expect(p).toContain("## बाकी स्क्रीन टेक्स्ट\n(कुछ नहीं)");
    expect(p).toContain("(नहीं है)");
    expect(p).toContain('{"place_hindi": ""');
  });

  it("does not offer a headline about the clip instead of the news", () => {
    expect(xvHeadlineProblem("एंकर के अनुसार खबर के लीड में विषय नहीं स्पष्ट हो पाया")).toMatch(/about the clip/);
    expect(xvHeadlineProblem("बिहार विधानसभा का सत्र शुरू, एंकर ने कहा कि मुद्दे उठेंगे")).toMatch(/about the clip/);
    expect(xvHeadlineProblem("क".repeat(201))).toMatch(/longer/);
    expect(xvHeadlineProblem("पोकरण-जोधपुर हाईवे पर सेना की एंबलेंस पलटी, तीन जवान गंभीर घायल")).toBeNull();
    expect(xvHeadlineProblem("फिल्म की स्क्रीनिंग में पहुंचे CM, वायरल वीडियो में दिखे विधायक")).toBeNull();
  });

  it("checks the answer", () => {
    expect(
      xvParseModelAnswer(JSON.stringify({ headline: " NH-52 पर भीषण सड़क हादसा | ", place_hindi: "निवाई", district_english: "Tonk", state_english: "Rajasthan", topic_hashtags: ["#TonkAccident", "TonkAccident", "#TonkAccident", 5] })),
    ).toEqual({ headline: "NH-52 पर भीषण सड़क हादसा", placeHindi: "निवाई", district: "Tonk", state: "Rajasthan", topicHashtags: ["#TonkAccident"] });
    expect(() => xvParseModelAnswer("not json")).toThrow(/JSON/);
    expect(() => xvParseModelAnswer(JSON.stringify({ headline: "  " }))).toThrow(/no headline/);
    expect(() => xvParseModelAnswer("[1]")).toThrow(/object/);
  });
});

describe("the next step", () => {
  it("goes to the headline only when the name holds none", () => {
    const off = xvNextSteps({ speech: false, headline: true });
    expect(off.afterProbe({ heading: null })).toBe("headline");
    expect(off.afterProbe({ heading: "a heading" })).toBeNull();
    const on = xvNextSteps({ speech: true, headline: true });
    expect(on.afterProbe({ heading: null })).toBe("read");
    expect(on.afterRead({ heading: null })).toBe("headline");
    expect(xvNextSteps({ speech: false, headline: false }).afterProbe({ heading: null })).toBeNull();
  });
});

describe("the headline role", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const share = new XvShareReader("\\\\server\\share");
  const read = (lines: string[], speech: XvScreenRead["speech"] = null): XvScreenRead => ({
    tookS: 2,
    durationS: 60,
    barLines: lines.map((text, i) => ({ text, secs: 9, firstS: 1 + 9 * i })),
    otherText: ["जयपुर से LIVE"],
    timings: { framesS: 1, ocrS: 1 },
    speech,
  });
  const clip = (over: Partial<XvClipRow> = {}) =>
    ({ id: "c1", folder: ["2026", "NOVEMBER 2026", "27-11-2026"], fileName: "KOTAA.mp4", day: "2026-11-27", heading: null, hasAudio: true, ...over }) as XvClipRow;
  const job = (over: Partial<XvClipRow> = {}) => ({ id: 1, clipId: "c1", step: "headline", attempts: 1, leaseUntil: new Date(), clip: clip(over) }) as unknown as XvClaimedJob;
  const answer = JSON.stringify({ headline: "अपनी खबर", place_hindi: "कोटा", district_english: "Kota", state_english: "Rajasthan", topic_hashtags: ["#Kota"] });
  let media: { screen: ReturnType<typeof vi.fn>; speech: ReturnType<typeof vi.fn> };
  let model: { model: string; ask: ReturnType<typeof vi.fn> };
  let step: XvHeadlineStep;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(xvQueueMissingHeadlines).mockResolvedValue(0);
    // The real finish runs `save` inside its transaction while the lease holds
    vi.mocked(xvFinishJob).mockImplementation(async (_db, _job, _next, save) => {
      await save?.({} as never);
      return true;
    });
    vi.mocked(xvRedoStep).mockResolvedValue(0);
    vi.mocked(xvDayScreens).mockResolvedValue([]);
    media = {
      screen: vi.fn().mockResolvedValue({ screenVersion: "xvs-1", ...read(["बार की पहली लाइन यहाँ", "बार की दूसरी लाइन यहाँ"]) }),
      speech: vi.fn().mockResolvedValue({ tookS: 3, seconds: 45, hasAudio: true, text: "खबर कोटा से है" }),
    };
    model = { model: "qwen3:14b", ask: vi.fn().mockResolvedValue({ content: answer, tokensOut: 40, tookS: 1.2, thought: false }) };
    step = new XvHeadlineStep({} as never, "org", share, media as never, model as never, log, () => new Date("2026-11-27T08:00:00Z"));
  });

  it("idles when there is no job, after queueing the clips that never had one", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(null);
    expect(await step.tick()).toBe(false);
    expect(vi.mocked(xvQueueMissingHeadlines).mock.calls[0]?.slice(1)).toEqual(["org", "2026-11-21"]);
    await step.tick();
    expect(xvQueueMissingHeadlines).toHaveBeenCalledTimes(1);
  });

  it("skips a clip whose name got a heading while it waited", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job({ heading: "अब नाम में हेडिंग है" }));
    expect(await step.tick()).toBe(true);
    expect(media.screen).not.toHaveBeenCalled();
    expect(vi.mocked(xvFinishJob).mock.calls[0]?.[2]).toBeNull();
  });

  it("reads the screen, asks the model, keeps both", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job());
    expect(await step.tick()).toBe(true);
    expect(media.screen).toHaveBeenCalledWith("c1", "\\\\server\\share\\2026\\NOVEMBER 2026\\27-11-2026\\KOTAA.mp4");
    expect(vi.mocked(xvSaveScreenRead).mock.calls[0]?.[2]).toBe("xvs-1");
    expect(media.speech).not.toHaveBeenCalled();
    expect(model.ask.mock.calls[0]?.[0]).toContain("बार की पहली लाइन यहाँ\nबार की दूसरी लाइन यहाँ");
    const [, id, headline, result] = vi.mocked(xvSaveHeadline).mock.calls[0]!;
    expect([id, headline]).toEqual(["c1", "अपनी खबर"]);
    expect(result).toMatchObject({ district: "Kota", linesUsed: ["बार की पहली लाइन यहाँ", "बार की दूसरी लाइन यहाँ"], usedSpeech: false, model: "qwen3:14b" });
    expect(xvSetProgress).toHaveBeenCalled();
  });

  it("asks the model again from a stored read, and hears the anchor when the programme leaves under 2 lines", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job());
    vi.mocked(xvGetScreen).mockResolvedValue({ clipId: "c1", screenVersion: "xvs-1", read: read(DAY.election1!), headline: null, result: null } as never);
    const others: XvDayScreen[] = ["election2", "election3", "chandna"].map((id) => ({ clipId: id, read: read(DAY[id]!), result: null, jobStatus: "pending" }));
    vi.mocked(xvDayScreens).mockResolvedValue(others);
    await step.tick();
    expect(media.screen).not.toHaveBeenCalled();
    expect(media.speech).toHaveBeenCalledWith("c1", expect.any(String), 45);
    expect(vi.mocked(xvSaveScreenRead).mock.calls[0]?.[3].speech?.text).toBe("खबर कोटा से है");
    const prompt = model.ask.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("## हेडलाइन बार (समय के क्रम में)\n(कुछ नहीं पढ़ा गया)");
    expect(prompt).toContain("खबर कोटा से है");
    expect(vi.mocked(xvSaveHeadline).mock.calls[0]?.[3]).toMatchObject({ linesUsed: [], usedSpeech: true });
  });

  it("keeps a headline about the clip as no suggestion, with the reason", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job());
    model.ask.mockResolvedValue({ content: JSON.stringify({ headline: "एंकर ने बताया कि खबर साफ़ नहीं" }), tokensOut: 9, tookS: 1, thought: false });
    await step.tick();
    const [, , headline, result] = vi.mocked(xvSaveHeadline).mock.calls[0]!;
    expect(headline).toBeNull();
    expect(result.rejected).toMatch(/^about the clip, not the news: एंकर ने बताया/);
  });

  it("writes again the day's clips whose lines the new programme changes", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job());
    media.screen.mockResolvedValue({ screenVersion: "xvs-1", ...read(DAY.election3!) });
    const done = (id: string, linesUsed: string[]): XvDayScreen => ({ clipId: id, read: read(DAY[id]!), jobStatus: "done", result: { linesUsed } as never });
    vi.mocked(xvDayScreens).mockResolvedValue([done("election1", DAY.election1!), done("election2", DAY.election2!), done("nabard1", DAY.nabard1!)]);
    await step.tick();
    expect(vi.mocked(xvRedoStep).mock.calls[0]?.slice(1)).toEqual([["election1", "election2"], "headline"]);
  });

  it("finishes without a suggestion (an older one cleared) when nothing was read or heard", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job({ hasAudio: false }));
    media.screen.mockResolvedValue({ screenVersion: "xvs-1", ...read([]), otherText: [] });
    await step.tick();
    expect(media.speech).not.toHaveBeenCalled();
    expect(model.ask).not.toHaveBeenCalled();
    const [, id, headline, result] = vi.mocked(xvSaveHeadline).mock.calls[0]!;
    expect([id, headline, result.linesUsed]).toEqual(["c1", null, []]);
  });

  it("waits without a try while the media service or the model is down", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job());
    media.screen.mockRejectedValueOnce(new XvMediaDown("ECONNREFUSED"));
    expect(await step.tick()).toBe(false);
    model.ask.mockRejectedValueOnce(new XvModelDown("ECONNREFUSED"));
    expect(await step.tick()).toBe(false);
    expect(xvDeferJob).toHaveBeenCalledTimes(2);
    expect(xvFailJob).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("counts a bad answer as a failed try, without the share's address", async () => {
    vi.mocked(xvClaimJob).mockResolvedValue(job());
    media.screen.mockRejectedValue(new Error("ffmpeg failed on \\\\server\\share\\2026\\x.mp4"));
    await step.tick();
    expect(vi.mocked(xvFailJob).mock.calls[0]?.[2]).toBe("headline: ffmpeg failed on <share>\\2026\\x.mp4");
    model.ask.mockResolvedValue({ content: "{}", tokensOut: 1, tookS: 1, thought: false });
    media.screen.mockResolvedValue({ screenVersion: "xvs-1", ...read(["बार की पहली लाइन यहाँ"]) });
    await step.tick();
    expect(vi.mocked(xvFailJob).mock.calls[1]?.[2]).toMatch(/no headline/);
  });
});

describe("the media service client", () => {
  let server: Server;
  let reply: (req: { url?: string; body: string }) => { status: number; body: string; delayMs?: number };
  let base = "";
  beforeEach(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const r = reply({ url: req.url, body });
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(r.body);
        }, r.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const screen = { screenVersion: "xvs-1", tookS: 2, durationS: 60, barLines: [{ text: "लाइन", secs: 3, firstS: 1 }], otherText: [], timings: { framesS: 1, ocrS: 1 } };
  const client = (ms = 2000) => new XvMediaClient(base, "k", { readMs: ms, screenMs: ms });

  it("posts the clip with the key and reads the answer", async () => {
    let seen = "";
    reply = (r) => ((seen = `${r.url} ${r.body}`), { status: 200, body: JSON.stringify(screen) });
    expect(await client().screen("c1", "S:\\a.mp4")).toEqual(screen);
    expect(seen).toBe('/screen {"clipId":"c1","path":"S:\\\\a.mp4"}');
  });

  it("waits (XvMediaDown) while a model loads, the clip is in work, or nothing listens", async () => {
    reply = () => ({ status: 503, body: '{"error":"ocr loading"}' });
    await expect(client().screen("c1", "p")).rejects.toBeInstanceOf(XvMediaDown);
    reply = () => ({ status: 409, body: '{"error":"busy"}' });
    await expect(client().speech("c1", "p", 45)).rejects.toBeInstanceOf(XvMediaDown);
    await expect(new XvMediaClient("http://127.0.0.1:9", "k").screen("c1", "p")).rejects.toBeInstanceOf(XvMediaDown);
  });

  it("fails the try on an error answer, a body that is not JSON, a wrong shape or a timeout", async () => {
    reply = () => ({ status: 404, body: '{"error":"file not found on the share"}' });
    await expect(client().screen("c1", "p")).rejects.toThrow("file not found on the share");
    reply = () => ({ status: 500, body: "<html>" });
    await expect(client().screen("c1", "p")).rejects.toThrow(/without JSON/);
    reply = () => ({ status: 200, body: '{"screenVersion":1}' });
    await expect(client().screen("c1", "p")).rejects.toThrow(/wrong shape/);
    reply = () => ({ status: 200, body: JSON.stringify(screen), delayMs: 300 });
    const err = await client(50).screen("c1", "p").catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(XvMediaDown);
    expect(String(err)).toMatch(/did not finish \/screen/);
  });
});

describe("the model client", () => {
  const answer = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  const client = new XvModelClient("http://ollama", "qwen3:14b");
  afterEach(() => vi.unstubAllGlobals());

  it("reads the reply", async () => {
    vi.stubGlobal("fetch", answer(200, { message: { content: "{}" }, eval_count: 9, done_reason: "stop" }));
    expect(await client.ask("p")).toMatchObject({ content: "{}", tokensOut: 9, thought: false });
  });

  it("waits while Ollama is down or the model is not pulled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(client.ask("p")).rejects.toBeInstanceOf(XvModelDown);
    vi.stubGlobal("fetch", answer(404, { error: "model not found" }));
    await expect(client.ask("p")).rejects.toBeInstanceOf(XvModelDown);
    vi.stubGlobal("fetch", answer(404, "not json"));
    await expect(client.ask("p")).rejects.toBeInstanceOf(XvModelDown);
  });

  it("fails the try on a cut-off answer, an empty body or an error", async () => {
    vi.stubGlobal("fetch", answer(200, { message: { content: '{"headline": "आध' }, done_reason: "length" }));
    await expect(client.ask("p")).rejects.toThrow(/cut off/);
    vi.stubGlobal("fetch", answer(200, "null"));
    await expect(client.ask("p")).rejects.toThrow(/no message/);
    vi.stubGlobal("fetch", answer(500, { error: "out of memory" }));
    await expect(client.ask("p")).rejects.toThrow(/out of memory/);
  });
});
