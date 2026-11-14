// The person handles' name spellings, from the published posts that carry each handle (handle fixes, section 3:
// "Missing Hindi names in the handle files", 14 Nov 2026).
//
// For every person handle of subject-handles.json (kind "person", names_hi / names_en) and party-handles.json (scope
// "mla", keywords_hi / keywords_en), and so for every office's handles (offices.*.handles are entries of those files):
//   1. its posts: the posts of the 8 days (day-replay.ts exports) whose text carries the @handle (or whose export lists it);
//   2. its name CORES: the names already listed with no title word in them ("बालमुकुंद आचार्य", not "मुख्यमंत्री
//      भजनलाल शर्मा"), or the names with their title words taken out when none is plain;
//   3. candidate spellings: runs of 1–4 words of a post that do not start or end on a postposition and whose letters
//      (spaces out, fold()ed) are within a small edit distance of a core's letters, in the same script: a different
//      vowel sign, a half-letter, the name written as one word ("बालमुकुंदाचार्य") or as two;
//   4. a spelling is ADDED when it is on at least 2 of the handle's posts and not already listed (fold()ed: the matcher
//      folds, so a nukta or chandrabindu variant is already matched); when it is added, its joined or spaced twin is
//      added too if it appears on any of the handle's posts;
//   5. a spelling that is a candidate for more than one person, or is already a name of another person, is CONTESTED:
//      added to neither and listed.
// Every spelling already in the files stays. Nothing comes from transliteration or guessing: only the posts' own text.
//
// CLI (packages/core; exports as in day-replay.ts, REPLAY_DAYS or REPLAY_EXPORTS_DIR):
//   npx tsx test/name-spellings.ts            report only (JSON on stdout)
//   npx tsx test/name-spellings.ts --write    also adds the spellings to the two files (their formatting kept)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fold } from "../src/fold";
import { dayExports, readExportPosts } from "./day-replay";

const CONFIG = new URL("../../../apps/worker/config/", import.meta.url);
const SUBJECTS = new URL("subject-handles.json", CONFIG);
const PARTIES = new URL("party-handles.json", CONFIG);

/** Title and office words: a name that holds one is not a plain name (its other words may still be a core) */
const TITLE_WORDS = new Set([
  "मुख्यमंत्री", "उपमुख्यमंत्री", "उप", "मंत्री", "राज्यमंत्री", "सीएम", "डिप्टी", "डॉ", "डॉ.", "श्री", "स्वामी", "बाबा", "विधायक", "सांसद", "नेता",
  "प्रतिपक्ष", "प्रदेशाध्यक्ष", "राज्यपाल", "भाजपा", "कांग्रेस", "Governor", "राज्य", "डीजीपी", "DGP", "पुलिस", "महानिदेशक", "आईपीएस", "IPS", "अध्यक्ष", "पूर्व", "केंद्रीय", "मुख्य", "सचिव", "कृषि", "चिकित्सा", "वित्त", "शिक्षा", "गृह", "ऊर्जा", "उद्योग",
  "CM", "Deputy", "Dr", "Dr.", "Shri", "Minister", "MLA", "MP", "Chief", "Secretary", "Swami", "Union", "Former",
].map((w) => fold(w)));
/** A run never starts or ends on one of these */
const STOP = new Set(["ने", "का", "की", "के", "को", "से", "में", "पर", "और", "व", "एवं", "तथा", "भी", "ही", "तक", "लिए", "द्वारा", "जी", "है", "हैं", "the", "of", "and", "to", "in"].map((w) => fold(w)));
const DEVANAGARI = /[ऀ-ॿ]/u;
const HANDLE = /@(\w{1,15})/g;

export interface PersonEntry {
  file: "subject" | "party";
  handle: string;
  /** The lists the spellings go into: names_hi/names_en (subjects) or keywords_hi/keywords_en (MLAs) */
  hiKey: "names_hi" | "keywords_hi";
  enKey: "names_en" | "keywords_en";
  names: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.normalize("NFC").trim()) : []);
const bare = (h: string) => h.replace(/^@/, "").toLowerCase();

export function personEntries(subjects: unknown = JSON.parse(readFileSync(SUBJECTS, "utf8")), parties: unknown = JSON.parse(readFileSync(PARTIES, "utf8"))): PersonEntry[] {
  const out: PersonEntry[] = [];
  for (const e of (subjects as { entries: Record<string, unknown>[] }).entries) {
    if (e.kind !== "person" || typeof e.handle !== "string") continue;
    out.push({ file: "subject", handle: e.handle, hiKey: "names_hi", enKey: "names_en", names: [...strings(e.names_hi), ...strings(e.names_en)] });
  }
  for (const e of (parties as { entries: Record<string, unknown>[] }).entries) {
    if (e.scope !== "mla" || typeof e.handle !== "string") continue;
    out.push({ file: "party", handle: e.handle, hiKey: "keywords_hi", enKey: "keywords_en", names: [...strings(e.keywords_hi), ...strings(e.keywords_en)] });
  }
  return out;
}

/** The plain names (no title word), or every name with its title words taken out; as word lists, NFC */
function cores(names: readonly string[]): string[][] {
  const split = (n: string) => n.normalize("NFC").split(/\s+/).filter(Boolean);
  const plain = names.map(split).filter((ws) => ws.length && !ws.some((w) => TITLE_WORDS.has(fold(w))));
  const list = plain.length ? plain : names.map((n) => split(n).filter((w) => !TITLE_WORDS.has(fold(w)))).filter((ws) => ws.length);
  const seen = new Set<string>();
  return list.filter((ws) => {
    const k = fold(ws.join(""));
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function levenshtein(a: string, b: string): number {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
}

/** Letters only, folded: "बाल मुकुंद" → "बालमुकुंद" */
const letters = (s: string) => fold(s.normalize("NFC")).replace(/\s+/g, "");
/** Edits allowed between a run and a core: none below 5 letters, 1 below 9, else 2 */
const allowed = (n: number) => (n < 5 ? 0 : n < 9 ? 1 : 2);

/** Whether two words are one spelling apart: the same first letter, and within the edits their length allows */
const wordClose = (a: string, b: string) => {
  const x = letters(a), y = letters(b);
  return !!x && !!y && [...x][0] === [...y][0] && levenshtein(x, y) <= allowed([...y].length);
};

/**
 * Whether a run of words is a spelling of the core, in the same script. With as many words as the core: word by word
 * ("दीया कुमारी" for "दिया कुमारी"). With a different number (the name joined or split: "बालमुकुंदाचार्य" for
 * "बालमुकुंद आचार्य"): its letters within the edits their length allows, starting like the core's first word and
 * ending like its last (so "भजनलाल शर्मा आज" is not "भजनलाल शर्मा").
 */
function spells(run: string, core: string): boolean {
  if (DEVANAGARI.test(run) !== DEVANAGARI.test(core)) return false;
  const rw = run.split(" "), cw = core.split(" ");
  if (rw.length === cw.length) return rw.every((w, i) => wordClose(w, cw[i]!));
  const a = letters(run), b = letters(core);
  if (!a || !b || [...a][0] !== [...b][0] || levenshtein(a, b) > allowed([...b].length)) return false;
  const tail = (x: string) => [...letters(x)].slice(-2).join("");
  return tail(rw.at(-1)!) === tail(cw.at(-1)!);
}

/** Word runs of a post (1–4 words, NFC, punctuation trimmed), never starting or ending on a postposition */
function runs(text: string): string[] {
  const words = text.normalize("NFC").replace(HANDLE, " ").replace(/#\S+/g, " ").split(/[\s,।॥;:!?|()"'‘’“”\-–—.…]+/u).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    if (STOP.has(fold(words[i]!))) continue;
    for (let k = 1; k <= 4 && i + k <= words.length; k++) {
      if (STOP.has(fold(words[i + k - 1]!))) continue;
      out.add(words.slice(i, i + k).join(" "));
    }
  }
  return [...out];
}

export interface SpellingReport {
  /** handle → its posts in the 8 days, the spellings added, and the twins added with them */
  handles: Record<string, { file: string; posts: number; added: string[] }>;
  /** Spellings that match more than one person: added to neither */
  contested: { spelling: string; handles: string[] }[];
}

/** The texts of the 8 days, with the handles each carries (lower-cased, no @) */
export function exportPosts(env = process.env): { text: string; handles: Set<string> }[] {
  const out: { text: string; handles: Set<string> }[] = [];
  for (const { path, present } of dayExports(env)) {
    if (!present) continue;
    for (const p of readExportPosts(path)) {
      const hs = new Set([...p.text.matchAll(HANDLE)].map((m) => m[1]!.toLowerCase()));
      for (const h of p.handles) hs.add(bare(h));
      out.push({ text: p.text.normalize("NFC"), handles: hs });
    }
  }
  return out;
}

export function nameSpellings(entries: readonly PersonEntry[], posts: readonly { text: string; handles: Set<string> }[]): SpellingReport {
  const listed = new Map(entries.map((e) => [bare(e.handle), new Set(e.names.map((n) => fold(n)))]));
  // spelling (NFC) → handle → posts it is on
  const found = new Map<string, Map<string, number>>();
  const seenOn = new Map<string, Set<string>>(); // handle → every run on its posts (for the twins)
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const h = bare(e.handle);
    const own = posts.filter((p) => p.handles.has(h));
    counts[h] = own.length;
    const cs = cores(e.names).map((ws) => ws.join(" "));
    const seen = new Set<string>();
    for (const p of own) {
      const rs = runs(p.text);
      for (const r of rs) seen.add(r);
      for (const r of new Set(rs.filter((r) => cs.some((c) => spells(r, c))))) {
        const m = found.get(r) ?? new Map<string, number>();
        m.set(h, (m.get(h) ?? 0) + 1);
        found.set(r, m);
      }
    }
    seenOn.set(h, seen);
  }
  // A candidate of more than one person, by its own posts or by spelling another person's core, is contested
  const coreOf = new Map(entries.map((e) => [bare(e.handle), cores(e.names).map((ws) => ws.join(" "))]));
  const report: SpellingReport = { handles: {}, contested: [] };
  const added = new Map<string, string[]>();
  for (const [spelling, byHandle] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) {
    const qualified = [...byHandle].filter(([, n]) => n >= 2).map(([h]) => h);
    if (!qualified.length) continue;
    const key = fold(spelling);
    const people = new Set([
      ...qualified,
      ...[...coreOf].filter(([, cs]) => cs.some((c) => spells(spelling, c))).map(([h]) => h),
      ...[...listed].filter(([, names]) => names.has(key)).map(([h]) => h),
    ]);
    if (people.size > 1) {
      report.contested.push({ spelling, handles: [...people].sort() });
      continue;
    }
    const h = qualified[0]!;
    if (listed.get(h)!.has(key)) continue;
    added.set(h, [...(added.get(h) ?? []), spelling]);
  }
  // The joined or spaced twin of an added spelling, when it is on any of the handle's posts and not contested
  const contested = new Set(report.contested.map((c) => fold(c.spelling)));
  for (const [h, list] of added) {
    const have = new Set([...listed.get(h)!, ...list.map((s) => fold(s))]);
    for (const s of [...list]) {
      for (const twin of seenOn.get(h) ?? []) {
        const k = fold(twin);
        // The same name with its words joined or split: another word count, a spelling of the same core
        if (have.has(k) || contested.has(k) || twin.split(" ").length === s.split(" ").length) continue;
        // ... and the same letters but for the joint ("बालमुकुंद आचार्य" → "बालमुकुंदाचार्य": आ becomes ा)
        if (levenshtein(letters(twin), letters(s)) > 1 || !coreOf.get(h)!.some((c) => spells(twin, c))) continue;
        have.add(k);
        list.push(twin);
      }
    }
  }
  for (const e of entries) {
    const h = bare(e.handle);
    report.handles[e.handle] = { file: e.file, posts: counts[h] ?? 0, added: added.get(h) ?? [] };
  }
  return report;
}

/** Adds the spellings to one entry's list in the file text, keeping the file's formatting */
function addToFile(text: string, handle: string, key: string, spellings: readonly string[]): string {
  const at = text.indexOf(`"handle": ${JSON.stringify(handle)}`);
  if (at < 0) throw new Error(`${handle} not found`);
  const k = text.indexOf(`"${key}":`, at);
  const next = text.indexOf(`"handle": "@`, at + 10);
  if (k < 0 || (next > 0 && k > next)) throw new Error(`${handle}: no "${key}" list`);
  const open = text.indexOf("[", k);
  const close = text.indexOf("]", open);
  const list = JSON.parse(text.slice(open, close + 1)) as string[];
  const merged = [...list, ...spellings.filter((s) => !list.includes(s))];
  const body = text.slice(open, close + 1);
  // A list written one item per line stays so (its items' indent, the closing bracket's); an inline one stays inline
  const lines = body.split("\n");
  const indent = (line: string) => /^\s*/.exec(line)![0];
  const out = lines.length > 1
    ? `[\n${merged.map((x) => `${indent(lines[1]!)}${JSON.stringify(x)}`).join(",\n")}\n${indent(lines.at(-1)!)}]`
    : JSON.stringify(merged).replace(/","/g, '", "');
  return `${text.slice(0, open)}${out}${text.slice(close + 1)}`;
}

export function writeSpellings(report: SpellingReport, entries: readonly PersonEntry[]): void {
  const files: Record<"subject" | "party", URL> = { subject: SUBJECTS, party: PARTIES };
  for (const file of ["subject", "party"] as const) {
    let text = readFileSync(files[file], "utf8");
    for (const e of entries.filter((x) => x.file === file)) {
      const add = report.handles[e.handle]?.added ?? [];
      const hi = add.filter((s) => DEVANAGARI.test(s));
      const en = add.filter((s) => !DEVANAGARI.test(s));
      if (hi.length) text = addToFile(text, e.handle, e.hiKey, hi);
      if (en.length) text = addToFile(text, e.handle, e.enKey, en);
    }
    JSON.parse(text);
    writeFileSync(files[file], text);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const entries = personEntries();
  const report = nameSpellings(entries, exportPosts());
  if (process.argv.includes("--write")) writeSpellings(report, entries);
  console.log(JSON.stringify(report, null, 1));
}
