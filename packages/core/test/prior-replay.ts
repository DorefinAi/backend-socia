// The reporter prior's replay, reported SEPARATELY and labelled an upper bound (reporter-prior brief L3).
//
// The published exports carry no file names, so the only way to know a post's reporter is the reporter handle the
// desk put ON the post — the answer itself (L1). That makes these numbers circular in one direction: every scored
// post is one where the desk tagged the reporter, mostly political and government copy (L2). They are never added
// to the per-day hashtag floors (day-replay.ts) and never gate anything.
//
// For each post with exactly one roster reporter handle: compose the copy (handles stripped) with that reporter's
// file-name token, and score the prior's handle suggestions against the handles the desk really wrote.
//
// CLI: npx tsx test/prior-replay.ts            (exports as in day-replay.ts, plus the fixture sample)

import { readFileSync } from "node:fs";
import {
  PlaceBook, composeBreaking, parseBeatHandles, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles,
  segmentPost,
} from "../src";
import { dayExports, readExport } from "./day-replay";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
const beats = parseBeatHandles(cfg("beat-handles.json"), directory);
// A token per reporter handle: the first names_en the roster matches on
const tokenOf = new Map<string, string>();
for (const [token, m] of reporters.byToken) if (!tokenOf.has(m.handle.toLowerCase())) tokenOf.set(m.handle.toLowerCase(), token);

const HANDLE = /@(\w{1,15})/g;

export interface PriorReplay {
  label: string;
  posts: number;
  withReporter: number;
  offered: number;
  hits: number;
  byHandle: Map<string, { offered: number; hits: number }>;
}

export function priorReplay(label: string, texts: readonly string[]): PriorReplay {
  const r: PriorReplay = { label, posts: texts.length, withReporter: 0, offered: 0, hits: 0, byHandle: new Map() };
  for (const text of texts) {
    const used = new Set([...text.matchAll(HANDLE)].map((m) => m[1]!.toLowerCase()));
    const mine = [...used].filter((h) => tokenOf.has(h));
    if (mine.length !== 1) continue;
    r.withReporter++;
    const s = segmentPost(text.replace(HANDLE, " "));
    const d = composeBreaking(
      { headline: s.headline, points: s.points, district: null, town: null, rajasthan: true, leaderPost: false, reporterToken: tokenOf.get(mine[0]!)! },
      rules, book, { subjects, reporters, parties, beats },
    );
    for (const h of d.handleSuggestions.filter((x) => x.reason === "prior" || x.reason === "beat")) {
      const k = `${h.reason === "beat" ? "beat " : ""}@${h.handle}`;
      const row = r.byHandle.get(k) ?? { offered: 0, hits: 0 };
      row.offered++;
      r.offered++;
      if (used.has(h.handle.toLowerCase())) {
        row.hits++;
        r.hits++;
      }
      r.byHandle.set(k, row);
    }
  }
  return r;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");

if (process.argv[1]?.endsWith("prior-replay.ts")) {
  const sets: [string, string[]][] = [];
  const sample = JSON.parse(readFileSync(new URL("./fixtures/published-posts-sample.json", import.meta.url), "utf8")) as { posts: { text: string }[] };
  sets.push(["fixture sample", sample.posts.map((p) => p.text)]);
  for (const { day, path, present } of dayExports()) if (present) sets.push([day, readExport(path)]);
  console.log("Reporter prior — UPPER BOUND, reporter taken from published handles (L3); not part of any floor\n");
  for (const [label, texts] of sets) {
    const r = priorReplay(label, texts);
    console.log(`${label.padEnd(15)} ${r.posts} posts, ${r.withReporter} with one roster reporter; prior offered ${r.offered}, desk used ${r.hits} (${pct(r.hits, r.offered)})`);
    for (const [h, x] of [...r.byHandle].sort((a, b) => b[1].offered - a[1].offered)) console.log(`    ${h.padEnd(24)} offered ${x.offered}, used ${x.hits} (${pct(x.hits, x.offered)})`);
  }
}
