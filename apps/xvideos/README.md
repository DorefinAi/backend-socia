# X Videos backend: architecture

Branch `xvideos` (worktree `backend-xvideos`), folder `apps/xvideos`. The video desk ("X Videos", shown on the desk as X Clips) is kept apart
from the X post desk (breaking news, `main`): every file, table, route, process and setting of it is named `xvideos`.
The product side (what the desk shows, composer rules, the headline steps H1–H3) is in the frontend repo:
`docs/xvideos/BACKEND-PLAN.md`. This file is how it is built. Steps 1–3 below are built; 4–7 are not.

## 1. The rule this design follows

**The live desk is never touched.** The live api (`:8200`) and worker run from `backend` on `main` and are not restarted
for this work. X Videos runs as **its own processes**, from this worktree, in **its own Postgres schema** (`xvideos`) with
**its own migrations**. It is built on a **test database** (now `socia_phase1_e2e`, a copy of the desk's data, schema `xvideos` only) and moved to `socia` only when done:
the migration script and the worker both refuse `socia` until told otherwise (`XVIDEOS_MIGRATE_LIVE=yes`,
`XVIDEOS_LIVE_DB=yes`).

```
                 \\10.1.1.20\fin_data\EXPORT FOR YOUTUBE   (read only)
                                │
   ┌────────────────────────────┼──────────────────────────────────────┐
   │ X Videos (branch xvideos)  ▼                                      │
   │  xvideos-worker   watch ─► probe ─► read ──► xvideos-media (GPU)  │
   │  (Node)                              ▲        127.0.0.1:8300      │
   │                                      └─ transcript, cuts, stills  │
   │  api with XVIDEOS=true  :8210   /xvideos/clips …  video by range  │
   └───────────────┬────────────────────────────────────────────────────┘
                   ▼ schema xvideos                ▲ X Videos desk (frontend xvideos,
     Postgres  socia_phase1_e2e (test) → socia        NEXT_PUBLIC_XVIDEOS_SOURCE=api)
     live api :8200 + live worker (main): unchanged
```

## 2. One folder

Everything X Videos is in `apps/xvideos` (workspace package `@socia/xvideos`). The rest of the backend is not changed
for it; the only link is **routing**: `apps/api/src/app.ts` mounts this folder's routes when `XVIDEOS=true`, handing in
the api's own sign-in check and error type (and `apps/api/package.json` lists the package).

| Where | What |
|---|---|
| `src/share/rules.ts` | The share's layout (year / month / day folders, month case not fixed), the `x` and `done` marks (`x...`, `X..`, `x......done......`, `x..doneकांग्रेस…`, `GEHLOT...done`, the typo `dpone`), the title left in a name, the size+time fingerprint. Pure. |
| `src/db/` | `schema.ts` (pgSchema `xvideos`), `clips.ts` (record a scan, mark gone, the job queue, reads for the API), `migrate.ts`. Uses only `createDb`, `orgs` and the `Db` type from `@socia/db`. |
| `migrations/`, `drizzle.config.ts`, `scripts/migrate.ts` | Own migrations, journal `xvideos.__migrations`. `pnpm --filter @socia/xvideos generate` / `migrate`. |
| `src/worker/` | Its own process (`main.ts`): `watch.ts`, `probe.ts`, `read.ts` (speech, off by default), `share.ts` (read-only share reader with timeouts), `config.ts`, `loop.ts` (a copy of the worker's loop). |
| `src/api/` | `routes.ts` (a Fastify plugin, exported as `@socia/xvideos/api`), `view.ts` (a clip → the desk's `XvClip` shape). |
| `media/` | `media.py`: speech, scene cuts and stills on the GPU (only with `XVIDEOS_SPEECH=on`). |
| `test/` | `rules`, `worker`, `view` tests (`pnpm --filter @socia/xvideos test`). |
| `.env` (not committed), `.env.example` | Settings for the worker, the migration, the media service and the api's X Videos routes. |

Names exported from here are prefixed `xv` / `Xv` / `XV_`.

## 3. Database: schema `xvideos`

| Table | Holds |
|---|---|
| `xvideos.clip` | One row per settled video file: folder parts and name as found (updated on rename), size, mtime, `fingerprint` (size:mtime, unique per org), `picked` / `done` marks, `title` from the name, `status` (`seen`, `reading`, `new`, `failed`, `gone`), `progress`, ffprobe fields, `poster_key`, `error`, seen / gone times |
| `xvideos.clip_job` | The work queue: `probe` then `read` per picked clip; attempts, lease, next attempt, last error. Claimed with `FOR UPDATE SKIP LOCKED`; an expired lease is taken again; 3 failures fail the clip. |
| `xvideos.clip_evidence` | What the media service read: transcript with times, cut times, stills (cache keys), contact sheet, version, time taken |

The only link to the X post desk's tables is `org_id → public.orgs`. Drafts, holds, posts and training examples come with
the headline steps (5–6).

## 4. One clip, step by step

| Step | Who | What |
|---|---|---|
| watch | worker, every `XVIDEOS_SCAN_SECONDS` (30) | Lists today's and yesterday's day folders (IST) and the shift folders under them (3 deep), read only, 20 s timeout per call. A file is recorded once two scans in a row see the same size and time (the copy has finished). A known fingerprint under a new name is the same clip renamed (`x` → `x…done`). Only `x` files get a `probe` job. A day folder listed completely marks its missing clips `gone`; a partial listing never does. |
| probe | worker | `ffprobe` (length, size, codec, sound) and a poster still at 10 % (max 8 s) into `XVIDEOS_CACHE/posters/`. With speech off (the default) the clip is now ready on the desk (`new`); with `XVIDEOS_SPEECH=on` it queues `read`. |
| read (only with `XVIDEOS_SPEECH=on`; off by default) | worker → `POST 127.0.0.1:8300/read` | The media service decodes the audio with ffmpeg, runs Whisper large-v3 batched (8 s chunks, about 6 s for a 3 min clip), finds scene cuts, writes a still every 2 s (spread wider past 10 min) and a 4×3 contact sheet into `XVIDEOS_CACHE/frames/<clip>/`. One clip at a time holds the GPU. The worker saves the evidence and the clip turns `new`. If the service is down, the clip waits in `reading` and is asked again every minute; it is never failed for that. |

The share is never written, renamed or deleted: the reader only lists and stats, ffmpeg and ffprobe only read, and the
media service refuses paths outside `XVIDEOS_SHARE` and writes only inside `XVIDEOS_CACHE`.

## 5. API (`XVIDEOS=true`, same sign-in as the desk, needs "Post Studio: X")

| Route | Does |
|---|---|
| `GET /xvideos/clips?status=&since=&limit=` | The picked clips of the last 48 h (default), newest first, without transcripts |
| `GET /xvideos/clips/:id` | One clip with its transcript, stills and cut times |
| `GET /xvideos/clips/:id/video` | The video, streamed from the share, with byte ranges (seeking) |
| `GET /xvideos/clips/:id/poster` | The poster still |
| `GET /xvideos/clips/:id/frames/:name` | A still or the contact sheet (`name` checked; paths never leave the cache) |

Answers use the frontend's `XvClip` field names (`view.ts`). A clip marked done on the share is `posted` (the desk posted
it by hand). Headline, place, tags and mentions stay empty until the headline steps.

## 6. Frontend link (frontend branch `xvideos`)

`NEXT_PUBLIC_XVIDEOS_SOURCE=api` switches the X Videos desk from its demo clips to `/xvideos/clips` (polled every 15 s and on
Refresh; the transcript is fetched when the editor opens a clip). `src/lib/xvideos/` holds the client and the mapping;
the desk's own actions (post, reject) still stay in the tab until step 6. Default stays `demo`.

## 7. Running it on the test database

`apps/xvideos/.env` (not committed; see `.env.example`):

```
DATABASE_URL=postgresql://socia:…@localhost:5432/socia_phase1_e2e
ORG_ID=…                                   same org as the desk
XVIDEOS_SHARE=\\10.1.1.20\fin_data\EXPORT FOR YOUTUBE
XVIDEOS_CACHE=C:\vartmaan\data\xvideos-cache
XVIDEOS_MEDIA_URL=http://127.0.0.1:8300
XVIDEOS=true
PORT=8210
```

From PowerShell (a Git Bash shell cannot see the share), in the backend folder:

```
pnpm --filter @socia/xvideos migrate                                       the xvideos schema
pnpm --filter @socia/xvideos worker                                        watch + probe (UV_THREADPOOL_SIZE=16)
node --env-file=apps/xvideos/.env --import tsx apps/api/src/index.ts       the api, X Videos routes on (XVIDEOS=true)
python -I apps/xvideos/media/media.py                                      only with XVIDEOS_SPEECH=on
```

Moving to `socia` when done: back up `socia`, run the X Videos migrations with `XVIDEOS_MIGRATE_LIVE=yes`, point
`apps/xvideos/.env` at `socia` with `XVIDEOS_LIVE_DB=yes`. Nothing in `public` changes.

## 8. When things go wrong

| What | What happens |
|---|---|
| Share unreachable | Logged once, then hourly; clips already found stay; the video route says the file is not on the share |
| Listing cut short | Nothing is marked gone; logged as incomplete |
| File renamed or moved mid-step | The step waits for the next scan, which finds it under its new name |
| Media service down or loading | Clips wait in `reading`, asked again every minute |
| A step fails 3 times | The clip is `failed` with the reason, shown on the desk |
| X Videos processes stop | The live desk is unaffected; leases bring each clip back to its step on restart |

## 9. Build order

| # | Piece | State |
|---|---|---|
| 1 | Schema, migrations, share rules, watcher, probe | Built |
| 2 | API routes, frontend switch to live clips | Built |
| 3 | Media service: speech, cuts, stills | Built, switched off (`XVIDEOS_SPEECH=on` turns it on); the desk only loads clips for now |
| 4 | Screen text (headline bar, slug, name strip) | Needs the vision model download (approval) |
| 5 | Headline from rules (H1), scored on the 26 posted clips | Next |
| 6 | Desk actions saved (edit, hold, post, undo, reject), training examples | |
| 7 | Model headline (H2), then LoRA (H3) | Only when each beats the step before |
