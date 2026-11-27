// Training step 1: what the screen and the anchor say, for videos whose desk headline we know.
//
// Two sources, one output line per video (JSONL, appended; a video already in the file is skipped, so a run that stops
// can simply be started again):
//
//   share    (default) clips on the share whose FILE NAME holds the desk's headline (clip.heading). 27 Nov 2026: all 29
//            videos the desk posted on X had their headline as the file name, so the name is the desk's own headline
//            for that video. Oldest day first: the share deletes files after about 6 days.
//   dataset  a folder of X posts (dataset.jsonl + videos/<post_id>.mp4, as Desktop\reach checker\firstindia_videos_*):
//            the posted title is the headline. These are the TEST set.
//
// For each video it asks the media service (media/media.py, must be running) for POST /screen (bar lines, other screen
// text) and POST /speech (the anchor's first 45 s). Speech is read for every video because the day's programme filler
// (src/headline/lines.ts) is only known later, at build time, and the files will be gone by then.
//
// Read only on the share and the database (nothing is written there); writes only the output file.
//
//   node --env-file=.env --import tsx training/capture-pairs.ts [--since 2026-11-22] [--limit 50] [--out <file>]
//   node --env-file=.env --import tsx training/capture-pairs.ts --dataset "<folder>" [--out <file>]
//      (dataset mode: start a second media service whose XVIDEOS_SHARE is that folder, and pass --media http://127.0.0.1:8301)

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDb } from "@socia/db";
import { sql } from "drizzle-orm";
import { XvMediaClient, XvMediaDown } from "../src/worker/read";
import { XvShareReader } from "../src/worker/share";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (apps/xvideos/.env)`);
  return v;
};

const dataset = arg("--dataset");
const out = arg("--out") ?? join(need("XVIDEOS_CACHE"), "training", dataset ? "xposts-reads.jsonl" : "share-reads.jsonl");
const media = new XvMediaClient(arg("--media") ?? process.env.XVIDEOS_MEDIA_URL ?? "http://127.0.0.1:8300", need("XVIDEOS_MEDIA_KEY"));
const limit = Number(arg("--limit") ?? "0") || Infinity;
const SPEECH_S = 45;

/** One video to read: where it is and the headline the desk gave it */
interface Item {
  id: string;
  path: string;
  day: string;
  headline: string;
  source: "share" | "xpost";
  fileName: string;
}

function done(): Set<string> {
  if (!existsSync(out)) return new Set();
  return new Set(
    readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { id: string }).id),
  );
}

async function shareItems(): Promise<Item[]> {
  const { db, close } = createDb(need("DATABASE_URL"), 1);
  const share = new XvShareReader(need("XVIDEOS_SHARE"));
  const since = arg("--since") ?? "2000-01-01";
  const rows = await db.execute<{ id: string; folder: string[]; file_name: string; day: string; heading: string }>(sql`
    select id, folder, file_name, day::text as day, heading from xvideos.clip
    where org_id = ${need("ORG_ID")} and status <> 'gone' and heading is not null and day >= ${since}
    order by day, mtime`);
  await close();
  return rows.rows.map((r) => ({ id: r.id, path: share.pathOf(r.folder, r.file_name), day: r.day, headline: r.heading, source: "share", fileName: r.file_name }));
}

function datasetItems(dir: string): Item[] {
  const rows = readFileSync(join(dir, "dataset.jsonl"), "utf8")
    .replace(/^\uFEFF/, "")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { post_id: string; posted_ist: string; title: string });
  return rows.map((r) => ({ id: `x-${r.post_id}`, path: join(dir, "videos", `${r.post_id}.mp4`), day: r.posted_ist.slice(0, 10), headline: r.title, source: "xpost", fileName: `${r.post_id}.mp4` }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function read(item: Item) {
  // The service down or busy: wait and try again, a few times, before giving up on the run
  for (let tries = 0; ; tries++) {
    try {
      const screen = await media.screen(item.id, item.path);
      const speech = await media.speech(item.id, item.path, SPEECH_S).catch((err: Error) => ({ text: "", tookS: 0, seconds: 0, hasAudio: false, error: err.message }));
      return { screen, speech };
    } catch (err) {
      if (err instanceof XvMediaDown && tries < 5) {
        await wait(30_000);
        continue;
      }
      throw err;
    }
  }
}

const items = dataset ? datasetItems(dataset) : await shareItems();
const have = done();
const todo = items.filter((i) => !have.has(i.id)).slice(0, limit);
mkdirSync(dirname(out), { recursive: true });
console.log(`${items.length} videos with a headline, ${have.size} already read, ${todo.length} to read now -> ${out}`);

let ok = 0;
let failed = 0;
const started = Date.now();
for (const item of todo) {
  try {
    const { screen, speech } = await read(item);
    appendFileSync(
      out,
      JSON.stringify({
        id: item.id,
        source: item.source,
        day: item.day,
        fileName: item.fileName,
        headline: item.headline,
        screenVersion: screen.screenVersion,
        barLines: screen.barLines.map((l) => l.text),
        otherText: screen.otherText,
        speech: speech.text,
        durationS: screen.durationS,
      }) + "\n",
      "utf8",
    );
    ok++;
  } catch (err) {
    failed++;
    // A file deleted from the share since the list was made is expected; anything else is shown
    console.warn(`skip ${item.fileName}: ${(err as Error).message.slice(0, 160)}`);
    if (err instanceof XvMediaDown) break;
  }
  if ((ok + failed) % 25 === 0) console.log(`${ok + failed}/${todo.length} (${ok} read, ${failed} skipped), ${Math.round((Date.now() - started) / 60_000)} min`);
}
console.log(`done: ${ok} read, ${failed} skipped, ${Math.round((Date.now() - started) / 60_000)} min`);
