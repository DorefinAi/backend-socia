// Training steps 3 and 5: scores headline writers on test.jsonl (build-pairs.ts), the same way the trials scored them.
//
// For each test video the model gets the production prompt and its headline is compared with the desk's: word match
// (share of the desk's words found, as x_headline.py's word_cover) and letter similarity. Writers compared:
//
//   <model>            the prompt as production sends it (e.g. qwen3:14b today, qwen3-xv once trained)
//   <model>+examples   the same, with the 8 training headlines most like this video's screen text added as style
//                      examples (no training needed; the baseline a trained model must beat)
//
//   node --env-file=.env --import tsx training/evaluate.ts [--models qwen3:14b,qwen3-xv] [--examples 8]
//   writes <XVIDEOS_CACHE>/training/eval-<time>.json

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { xvLineKey, xvSimilarity } from "../src/headline/lines";
import { XvModelClient, xvParseModelAnswer } from "../src/headline/model";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = join(process.env.XVIDEOS_CACHE ?? ".", "training");
const models = (arg("--models") ?? "qwen3:14b").split(",");
const nExamples = Number(arg("--examples") ?? "8");
const ollama = process.env.XVIDEOS_OLLAMA_URL ?? "http://127.0.0.1:11434";

interface Row {
  id: string;
  day: string;
  messages: { role: string; content: string }[];
}
const load = (f: string): Row[] =>
  readFileSync(join(dir, f), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
const test = load("test.jsonl");
const train = load("train.jsonl");
const headlineOf = (r: Row) => (JSON.parse(r.messages[1]!.content) as { headline: string }).headline;
const promptOf = (r: Row) => r.messages[0]!.content;

// The trials' word match: the desk's words (minus small words) found in ours
const STOP = new Set("के का की को में पर से ने है हैं और व तक भी इस यह एक किया हुआ हुई गया गई पहुंचे पहुंची बड़ा बड़ी लेकर लिए साथ आज".split(" "));
const words = (s: string) => (s.replaceAll("।", " ").normalize("NFC").match(/[\u0900-\u097FA-Za-z0-9]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
const cover = (real: string, got: string) => {
  const r = words(real);
  const g = words(got);
  return r.filter((w) => g.some((p) => xvSimilarity(w.toLowerCase(), p.toLowerCase()) >= 0.75)).length / Math.max(r.length, 1);
};

// The training headlines most like a test video's screen text (shared words), as style examples
const trainWords = train.map((r) => ({ headline: headlineOf(r), words: new Set(words(promptOf(r).split("## हेडलाइन बार")[1] ?? "")) }));
function examplesFor(prompt: string): string[] {
  const mine = new Set(words(prompt.split("## हेडलाइन बार")[1] ?? ""));
  return trainWords
    .map((t) => ({ t, score: [...t.words].filter((w) => mine.has(w)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, nExamples)
    .map((x) => x.t.headline);
}
const withExamples = (prompt: string, ex: string[]) =>
  prompt.replace("## हेडलाइन बार (समय के क्रम में)", `## डेस्क की मिलती-जुलती पुरानी हेडलाइन (सिर्फ़ शैली के लिए; इनके तथ्य मत लेना)\n${ex.map((h) => `- ${h}`).join("\n")}\n\n## हेडलाइन बार (समय के क्रम में)`);

const writers = models.flatMap((m) => [
  { name: m, model: m, examples: false },
  { name: `${m}+examples`, model: m, examples: true },
]);
const results: Record<string, { cover: number; letters: number; failed: number; n: number }> = {};
const detail: { id: string; desk: string; got: Record<string, string> }[] = [];

for (const r of test) {
  const desk = headlineOf(r);
  const row = { id: r.id, desk, got: {} as Record<string, string> };
  for (const w of writers) {
    const res = (results[w.name] ??= { cover: 0, letters: 0, failed: 0, n: 0 });
    const prompt = w.examples ? withExamples(promptOf(r), examplesFor(promptOf(r))) : promptOf(r);
    try {
      const got = xvParseModelAnswer((await new XvModelClient(ollama, w.model).ask(prompt)).content).headline;
      res.cover += cover(desk, got);
      res.letters += xvSimilarity(xvLineKey(got), xvLineKey(desk));
      row.got[w.name] = got;
    } catch {
      res.failed++;
    }
    res.n++;
  }
  detail.push(row);
  if (detail.length % 10 === 0) console.log(`${detail.length}/${test.length}`);
}

const summary = Object.fromEntries(
  Object.entries(results).map(([k, v]) => [k, { wordMatch: +(v.cover / v.n).toFixed(3), letterMatch: +(v.letters / v.n).toFixed(3), failed: v.failed, videos: v.n }]),
);
console.table(summary);
writeFileSync(join(dir, `eval-${Date.now()}.json`), JSON.stringify({ summary, detail }, null, 1), "utf8");
