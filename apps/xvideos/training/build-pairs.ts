// Training step 2: the captured reads (capture-pairs.ts) as training examples, exactly as production asks the model.
//
// For each video: the day's programme filler is dropped from its bar lines (src/headline/lines.ts, with that day's
// other reads), the anchor's words are used when fewer than 2 bar lines are left, and the prompt is built with the
// production prompt (src/headline/model.ts xvHeadlinePrompt). The answer the model should give is the desk's headline:
//
//   headline          the desk's headline without its " | ... News" ending (production adds the ending itself)
//   district / state  from that ending when it names a Rajasthan district ("| Jaipur News"), else what the base model said
//   place, topics     what the base model (qwen3:14b) says for the same prompt (--distill), so training changes the
//                     headline and nothing else the composer reads
//
// Cleaning: one example per story (the same headline seen twice, e.g. copies in two folders or days, is kept once),
// headlines that are too short or not Hindi are left out, and videos with nothing read and nothing heard are left out.
// Split by day, never at random: --test-days (default 2026-11-27) and every X post (dataset source) go to test.jsonl.
//
//   node --env-file=.env --import tsx training/build-pairs.ts [--in a.jsonl,b.jsonl] [--test-days 2026-11-27] [--distill]
//   writes <XVIDEOS_CACHE>/training/train.jsonl, test.jsonl and build-report.json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { xvLoadDirectory } from "../src/compose/compose";
import { XV_MIN_BAR_LINES, xvCleanLines, xvDayProgramme, xvLineKey } from "../src/headline/lines";
import { XvModelClient, xvHeadlinePrompt, xvParseModelAnswer } from "../src/headline/model";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = join(process.env.XVIDEOS_CACHE ?? ".", "training");
const inputs = (arg("--in") ?? [join(dir, "share-reads.jsonl"), join(dir, "xposts-reads.jsonl")].join(",")).split(",").filter((f) => existsSync(f));
const testDays = new Set((arg("--test-days") ?? "2026-11-27").split(","));
const distill = args.includes("--distill");
const model = new XvModelClient(process.env.XVIDEOS_OLLAMA_URL ?? "http://127.0.0.1:11434", process.env.XVIDEOS_HEADLINE_MODEL ?? "qwen3:14b");

interface Read {
  id: string;
  source: "share" | "xpost";
  day: string;
  fileName: string;
  headline: string;
  barLines: string[];
  otherText: string[];
  speech: string;
}

const reads: Read[] = inputs.flatMap((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Read),
);

// The desk's headline and its ending: "हेडलाइन | Jaipur News" -> ("हेडलाइन", "Jaipur News")
const SUFFIX = /\s[|।]\s?/;
const places = xvLoadDirectory().places;
function target(full: string): { headline: string; district: string; state: string } {
  const [head = "", ...rest] = full.split(SUFFIX);
  const ending = rest.join(" ").replace(/\bNews\b/gi, "").trim();
  const hit = places.find((p) => p.terms.test(ending));
  const outside = /^(India|Delhi|Bihar|Haryana|Punjab|Gujarat|Uttar Pradesh|Madhya Pradesh|Maharashtra)$/i.test(ending);
  return { headline: head.trim().replace(/[|।]+$/, "").trim(), district: hit?.tag ?? "", state: outside ? ending : hit ? "Rajasthan" : "" };
}
const HINDI = /[\u0900-\u097F]/;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// The day's programme, from every read of that day (as production sees it at the end of the day)
const byDay = new Map<string, Read[]>();
for (const r of reads) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
const programmes = new Map([...byDay].map(([day, rs]) => [day, xvDayProgramme(rs.map((r) => ({ clipId: r.id, lines: r.barLines })))]));

const report = { reads: reads.length, duplicates: 0, tooShort: 0, nothingRead: 0, distillFailed: 0, train: 0, test: 0, days: {} as Record<string, number> };
const seen = new Set<string>();
const train: string[] = [];
const test: string[] = [];

for (const r of reads) {
  const t = target(r.headline);
  if (words(t.headline) < 5 || !HINDI.test(t.headline)) {
    report.tooShort++;
    continue;
  }
  const key = xvLineKey(t.headline);
  if (seen.has(key)) {
    report.duplicates++;
    continue;
  }
  seen.add(key);
  const lines = xvCleanLines(r.barLines, programmes.get(r.day)!);
  const speech = lines.kept.length < XV_MIN_BAR_LINES ? r.speech : "";
  if (!lines.kept.length && !r.otherText.length && !speech.trim()) {
    report.nothingRead++;
    continue;
  }
  const prompt = xvHeadlinePrompt(lines.kept, r.otherText, speech);

  let base = { placeHindi: "", district: "", state: "", topicHashtags: [] as string[] };
  if (distill) {
    try {
      base = xvParseModelAnswer((await model.ask(prompt)).content);
    } catch {
      report.distillFailed++;
    }
  }
  const answer = {
    place_hindi: base.placeHindi,
    district_english: t.district || base.district,
    state_english: t.state || base.state || "Rajasthan",
    headline: t.headline,
    topic_hashtags: base.topicHashtags,
  };
  const line = JSON.stringify({
    id: r.id,
    day: r.day,
    source: r.source,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: JSON.stringify(answer) },
    ],
  });
  if (r.source === "xpost" || testDays.has(r.day)) test.push(line);
  else train.push(line);
  report.days[r.day] = (report.days[r.day] ?? 0) + 1;
}
report.train = train.length;
report.test = test.length;
writeFileSync(join(dir, "train.jsonl"), train.join("\n") + "\n", "utf8");
writeFileSync(join(dir, "test.jsonl"), test.join("\n") + "\n", "utf8");
writeFileSync(join(dir, "build-report.json"), JSON.stringify(report, null, 1), "utf8");
console.log(JSON.stringify(report));
