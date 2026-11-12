// Re-parses and re-composes one IST day of breaking stories from the database with the CURRENT code and
// data files, and writes what each draft would carry: district (and where it came from), the hashtags,
// the hashtag suggestions, the handles and their class. Nothing is written to the database.
//
// Run it before and after a logic change and diff the two files to see exactly which drafts moved:
//
//   node --env-file=.env --import tsx packages/db/scripts/replay-day.ts 2026-11-11 before.json
//   ...change the rules...
//   node --env-file=.env --import tsx packages/db/scripts/replay-day.ts 2026-11-11 after.json
//
// This is a regression tool, not a score: the database has the draft we composed, not what the desk
// published. Score against the desk with packages/core/test/hashtag-replay.ts and an X export.

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import {
  LEADER_POST, PlaceBook, composeBreaking, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles,
  parseSubjectHandles, slotFromTags,
} from "@socia/core";
import * as core from "@socia/core";

const [day, out] = process.argv.slice(2);
if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !out) {
  console.error("usage: replay-day.ts <YYYY-MM-DD, IST> <out.json>");
  process.exit(2);
}
const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
// Read only when this code has them, so the same script also replays the logic from before they existed
const c = core as Record<string, unknown>;
const maybe = (fn: string, file: string) => (typeof c[fn] === "function" ? (c[fn] as (j: unknown) => unknown)(cfg(file)) : undefined);
const extra = { normaliser: maybe("parseHashtagNormalise", "hashtag-normalise.json"), suggestRules: maybe("parseSuggestRules", "campaigns.json") };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows } = await db.query<{ id: string; source_text: string; file_name: string; created_at: Date }>(
  `select s.id, s.source_text, f.file_name, s.created_at from stories s join ingested_files f on f.id = s.file_id
    where s.layout = 'breaking' and s.source_text is not null
      and (s.created_at at time zone 'Asia/Kolkata')::date = $1::date
    order by s.created_at`,
  [day],
);
await db.end();

const result = rows.map((r) => {
  const p = parseBreaking(r.source_text, r.file_name, book);
  const slot = slotFromTags(p.tags);
  const d = composeBreaking(
    {
      headline: p.headline, points: p.points, district: p.district, town: p.town, rajasthan: p.rajasthan, leaderPost: LEADER_POST.test(p.headline),
      rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode,
    },
    rules, book, { subjects, reporters, parties, ...extra, at: r.created_at } as Parameters<typeof composeBreaking>[3],
  );
  const line1 = d.bodyText.split("\n")[0] ?? "";
  return {
    id: r.id, file: r.file_name, headline: p.headline, district: p.district, districtFrom: p.districtFrom,
    lead: [...line1.matchAll(/#([^\s#:]+)/gu)].map((m) => m[1]),
    hashtags: d.hashtags, hashtagSuggestions: d.hashtagSuggestions, mentions: d.mentions,
    mentionSuggestions: (d as { handleSuggestions?: { handle: string }[] }).handleSuggestions?.map((h) => h.handle) ?? [],
    cls: d.cls,
  };
});
writeFileSync(out, JSON.stringify(result, null, 1));
const count = (k: (x: (typeof result)[number]) => string) =>
  Object.entries(result.reduce<Record<string, number>>((a, x) => ((a[k(x)] = (a[k(x)] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
console.log(`${result.length} stories on ${day} → ${out}`);
console.log("district from:", count((x) => String(x.districtFrom)));
console.log("class:", count((x) => x.cls));
