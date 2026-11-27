# X Videos backend

The X Videos desk turns the desk's video exports on the office share into ready X video posts: title, `#FINVideo`, place,
hashtags and @handles. Editors check, copy and post by hand. This file is the whole design: what each folder holds, what
happens to one clip, where the models live, and what is built.

Branch `xvideos`, built in the worktree `digital\backend-xvideos`, merged to `main` when done. Everything X Videos is in
`apps/xvideos` and is named `xvideos` (tables, routes, processes, settings), so it stays apart from the breaking-news
desk.

---

## 1. Rules this design keeps

1. **The live desk is never touched.** X Videos runs in its own processes, its own Postgres schema (`xvideos`) and its own
   migrations. Until it is moved over, it runs on the test database.
2. **The share is read only.** Nothing writes, renames or deletes there. The desk renames files by hand.
3. **Code goes in git. Models, the Python environment and caches do not.** They live in `digital\x-requirements` (§2),
   which a setup script rebuilds from pinned versions.
4. **One place per job.** Rules are pure functions in `src/`, GPU work is in `media/`, tags and handles are in
   `directory/`. A reader should be able to find any step from §3.
5. **The model never posts on its own.** It suggests a headline and topic tags. Fixed parts (brand, `#FINVideo`, place,
   police handles) come from rules.

---

## 2. Folders

```
digital\
  backend\apps\xvideos\              in git (this folder)
    README.md                        this file
    .env.example                     every setting, with defaults
    src\share\rules.ts               the share layout, x / done marks, the title left in a file name (pure)
    src\worker\                      its own process: watch, probe, title, screen read, compose, learn
    src\db\  migrations\             schema "xvideos", own migrations
    src\api\                         the desk's routes (mounted by apps/api when XVIDEOS=true)
    test\                            vitest
    media\                           the Python GPU service
      media.py                       HTTP service on 127.0.0.1:8300: /health, /read, /headline
      headline.py                    screen reading: frames, OCR, bar lines, the model's headline
      requirements.txt               pinned versions of everything the service needs
      setup.ps1                      builds digital\x-requirements on a new machine (§9)
    directory\                       the X video tag and handle directory (§5)
      format.json tags.json handles.json     built files, read by the composer
      build.py eval.py collect.py            build it, test it, collect new #FINVideo posts
      data\finvideo-posts.jsonl              the desk's published #FINVideo posts

  x-requirements\                    NOT in git (it sits beside the backend and frontend repos, in neither): the heavy, machine-specific files
    env\                             Python 3.12 venv for media\ (GPU Paddle, faster-whisper)
    models\paddle\                   PaddleOCR detection + Devanagari recognition (about 0.1 GB)
    models\whisper\                  faster-whisper medium and large-v3 (about 4.3 GB)
    cache\                           posters, stills, frames, evidence per clip

dev-docs\xvideos-trials\             trial scripts and results (trials 1-5, day-2 check), for the record
```

qwen3:14b stays in Ollama's own store (other tools on this PC use the same Ollama). The settings only name the model.

---

## 3. One clip, step by step

```
 share (read only)
  \\10.1.1.20\fin_data\EXPORT FOR YOUTUBE\<year>\<MONTH year>\<dd-mm-yyyy>\<any inner folders>\<file>.mp4
        │
        ▼
 1 watch ──► 2 probe ──► 3 title from the file name ──┬── heading found ─────────────┐
   (worker)    (worker)    (worker, no GPU)            │                              ▼
                                                       └── no heading ──► 4 screen read ──► 5 compose ──► 6 desk ──► 7 learn
                                                                          (media service,    (worker)     (api +      (worker)
                                                                           GPU)                            frontend)
```

| # | Step | What it does | Where | State |
|---|---|---|---|---|
| 1 | Watch | Walks **today's day folder every 30 s** and **every day folder of the month every 10 min**, and the day the desk asks for with **Refresh** at once. It takes **every video at any depth inside a day folder** (the inner folders follow no fixed pattern: shift folders, desk folders, loose files); the `x` mark is kept as a flag, not a filter. Each day shows what its folder holds: the same video copied into two days is a clip in each. A file is recorded once two scans see the same size and time. A known size + time under a new name is the same clip renamed (`x` → `x…done`). The month and day follow the IST date: a new day folder is picked up when it appears, a new month folder on the 1st. | `src/worker/watch.ts` | Built (`XVIDEOS_SCAN_SECONDS`, `XVIDEOS_MONTH_SCAN_SECONDS`) |
| 2 | Probe | ffprobe (length, size, codec, sound) and a poster still. | `src/worker/probe.ts` | Built |
| 3 | Title from the file name | The name without the `x` / `done` marks and the extension. It is a heading when it has 5+ words and 8+ Devanagari letters. Windows does not allow `\|` in a name, so two or more spaces stand for ` \| `: the posted title comes back with its suffix. | `src/share/rules.ts` (`xvHeading`), stored as `clip.heading` | Built |
| 4 | Screen read | Only when step 3 finds no heading. `POST /headline` on the media service (§6). | `media/headline.py` | Tested (trials 4-5), **to move in** |
| 5 | Compose | Brand tag first, `#FINVideo` second, place tag, then tags and handles from the directory (§5). Emit or suggest per part. | `src/worker/compose.ts` | **To build** |
| 6 | Desk | Shows **every video in the chosen day folder**, with its inner folder and its `x` / done mark shown on the row. Opens on **today's day folder only** (IST), not yesterday's. A month / day selector outside the clip list picks another day. Edit, hold, Copy & Mark Posted, undo, reject (§8). | `src/api/` + frontend | List built (last 48 h); today-only + selector **next**; actions **to build** |
| 7 | Learn | A posted clip's final title, tags and handles go into the directory counts and become examples. | `src/worker/learn.ts` + `directory/build.py` | **To build** |

**Files are cleared from the share after about 6 days. A file not on the share is gone for good:** the desk no longer lists
it or its day, and nothing is archived. Its row stays only as `gone` (no video is copied), so a file that comes back is
the same clip. Last month's folders are checked until all their clips are gone.

---

## 4. The headline

### 4.1 From the file name first (measured 27 Nov 2026)

- All 29 videos the desk posted on X that day (11:57-14:05 IST) have their heading as a file name on the share: 26 within
  0.75 letter similarity, 3 the same heading with a longer suffix. **22 of the 29 files had no `x` mark.**
- X-marked files 22-27 Nov: 130 of 230 names hold a full heading. The rest are a word or two ("KOTAA", "JDR Hadsa",
  "cs v srinivas"). Those go to step 4.

### 4.2 Screen read when the name has no heading

Chosen after trials 4-5 (27 Nov 2026, scripts and numbers in `dev-docs\xvideos-trials`):

1. ffmpeg: one frame every 3 s over the first 75 s, scaled to 1280 wide.
2. Frames grouped by the picture of the red headline bar (one group per bar line).
3. PaddleOCR 3.x on the GPU (`PP-OCRv5_mobile_det` + `devanagari_PP-OCRv5_mobile_rec`), fixed screen regions only: the bar
   in every frame, the place tag and the right panel once per group.
4. Bar lines: the words of the bar joined left to right, logo bits dropped, the most typical reading of each line kept (vote),
   half-drawn and repeated lines removed.
5. Speech only as a fallback: when fewer than 2 bar lines were read (vertical shorts).
6. qwen3:14b (Ollama, `think: false`, JSON) writes the headline, the place and topic hashtags.

| Measured on | Clips | Median time | Word match with the desk | Place suffix right |
|---|---|---|---|---|
| 21 Nov (tuned on) | 26 | 2.8 s | 0.46 (was 0.39 at 68 s) | 15/26 |
| 27 Nov (held out) | 29 | 3.6 s (1080p) | 0.37: normal news 0.45, election clips 0.23 | 8/29 exact, 15/29 place named |

**Known fix before it goes in (day-2 check):** on election days a programme bar ("गांव की पंचायत") repeats the same 4 general
lines on every clip, and the clip's own result is only in the right panel. `headline.py` will (A) treat a bar line seen on 3+
of the day's clips as programme filler and (C) drop the programme name stuck to the front of each bar line.

---

## 5. Tags and handles: the directory

`#FINVideo` is the identifier: a post is an X video post exactly when it carries it. The directory is built from the desk's
own `#FINVideo` posts on X (427 posts over 11 days, 9 Sep-27 Nov 2026, more from `collect.py`).

It is a **layer on top of the breaking desk's directory** (`apps/worker/config/*.json`), not a copy:

| The breaking desk's directory keeps | The video directory adds |
|---|---|
| Who a handle is, its type, its Hindi and English names and keywords | Which tags and handles the desk uses **on video posts**, how often and how recently |
| District police and collectors, parties, offices, campaigns | The video post's layout (`format.json`): brand first, `#FINVideo` second (since 21 Nov 2026), place tag form, title suffix forms |
| | Video-only tags (`#PanchayatElectionsResult`) and handles the breaking directory lacks (`needs_keywords`) |
| | Emit or suggest per tag and handle, from how often the desk used it |

One fix to a handle or keyword in the breaking directory fixes both desks.

| File | Holds |
|---|---|
| `format.json` | Identifier, layout, tag order now, brand rule, `#RajasthanNews` share, place tag form, title suffix forms, file-name title rule |
| `tags.json` | Per tag: kind (identifier, brand, state, place, person, party, campaign, topic), uses, last seen, rule (emit / suggest), keywords copied from the breaking directory with their source, or `needs_keywords` with example titles and proposed words |
| `handles.json` | Per handle: kind (person, party, police, collector, institution, reporter, unknown), uses, last seen, rule, names and keywords from the breaking directory, or `needs_keywords` |

Rules: police handle is emitted when the district is known and the title is about a crime; everything else is suggested.
Reporter handles are never added from the title or the district (they are not in a video's title).

**Test** (`eval.py`, built from posts up to 13 Nov, tested on the 55 posts of 21 and 27 Nov, title only):
`#FINVideo` 100 %, brand 96 %, place tag found 83 %, collector 92 %, police 62 %, people / parties / offices 37 %, topic
tags 4 % (797 of 1,039 tags were used once: the model suggests those). To be re-run once `collect.py` has gathered a few
more days of live posts.

---

## 6. Media service (`media/`, Python, the GPU)

One process holds the GPU. It reads only under the share and writes only under `x-requirements\cache`.

| Route | Does |
|---|---|
| `GET /health` | Models loaded or not |
| `POST /read` | Speech (Whisper large-v3, batched 16, 8 s chunks), scene cuts, stills (built; off unless `XVIDEOS_SPEECH=on`) |
| `POST /headline` | Step 4 (§4.2): bar lines, other screen text, speech fallback, the model's headline, place and topic tags, timings |

Settings that matter:
- Whisper's CUDA libraries (ctranslate2) load **before** Paddle's, or Whisper fails with `WinError 127`. Whisper only finds
  cuBLAS after Paddle has loaded, so the service ships `nvidia-cublas-cu12` itself.
- `av==15.1.0` (PyAV 19 breaks faster-whisper 1.2.1).
- The speech fallback uses the batched Whisper already loaded for `/read` (one clip took 17-20 s with the unbatched
  medium model in the trial).

---

## 7. Database: schema `xvideos`

| Table | Holds | State |
|---|---|---|
| `clip` | One row per video file: folder parts and name as found, day folder's date (`day`), size, modified time, fingerprint (size:mtime), marks, title from the name, the heading when the name is one (`heading`), status (`seen`, `reading`, `new`, `failed`, `gone`), probe fields | Built |
| `clip_job` | Work queue (probe, read, headline), lease, attempts | Built (headline job to add) |
| `clip_evidence` | What the media service read: transcript, cuts, stills, bar lines, screen text | Built (bar lines to add) |
| `clip_draft` | Headline, its source (file name / screen read), suffix, tags and handles (value, emit or suggest, source) | To build |
| `clip_post` | Posted text, by whom, when, X link, undone | To build |
| `scan_request` | The desk's Refresh requests (one per day), taken by the watcher | Built |

---

## 8. API (`XVIDEOS=true`, same sign-in as the desk)

| Route | Does | State |
|---|---|---|
| `GET /xvideos/clips?day=&status=` | Every video of one day folder; without `day`, **today's (IST) only** | Built |
| `GET /xvideos/folders` | Today and every day whose folder holds videos, grouped by month, with counts (videos, x-marked, done), for the desk's month / day selector | Built |
| `POST /xvideos/rescan?day=` | The desk's Refresh: the watcher walks that day (default today) within seconds, and again 10 s later so new files settle | Built |
| `GET /xvideos/clips/:id` · `/video` · `/poster` · `/frames/:name` | One clip, the video with byte ranges, stills | Built |
| `PATCH /xvideos/clips/:id` | Save the editor's draft | To build |
| `POST /xvideos/clips/:id/hold` · `posted` · `undo` · `reject` | Desk actions | To build |

---

## 9. A new machine

```
git clone … ; cd digital\backend ; corepack pnpm install
powershell -File apps\xvideos\media\setup.ps1      builds digital\x-requirements: venv, pinned models, ollama pull qwen3:14b,
                                                   then reads one clip to check the GPU, OCR and model work
copy apps\xvideos\.env.example to .env.xvideos     fill DATABASE_URL, ORG_ID, keys
pnpm --filter @socia/xvideos migrate
```

Running (PowerShell; Git Bash cannot see the share):

```
pnpm --filter @socia/xvideos worker                watch, probe, title, compose
..\x-requirements\env\Scripts\python.exe -I apps\xvideos\media\media.py
node --env-file=… --import tsx apps/api/src/index.ts    the api with XVIDEOS=true
```

---

## 10. Build order

One commit per step, each reviewed before it moves on. Nothing reaches `main` until the whole flow passes on the test
database.

| # | Step | What is done | Starts | State |
|---|---|---|---|---|
| 1 | Base | Schema, share rules, watcher (today + yesterday), probe, list API, desk list | | Built |
| 2 | Collector | `directory/collect.py`: every hour, reads @1stIndiaNews' new posts, keeps the `#FINVideo` ones in `data/finvideo-posts.jsonl`. | Later, when the directory needs fresh posts | Left for later (27 Nov 2026) |
| 3 | Day folder + file-name title | Month + day scan at any depth, all videos, IST date; `GET /xvideos/folders`; `GET /xvideos/clips?day=` (today by default); title from the file name; desk: month / day selector, `x` mark and inner folder on each row | Next | |
| 4 | Screen read | `x-requirements` + `setup.ps1`; `headline.py` (trial flow + programme-bar fix A, C); `/headline`; headline job only for clips whose name has no heading | After 3 | |
| 5 | Tags and handles | Build the directory from the 427 saved `#FINVideo` posts (9 Sep-27 Nov 2026), finish tuning with `eval.py`; `compose.ts` builds `clip_draft`: brand, `#FINVideo`, place, tags, handles (emit / suggest) | After 4 | |
| 6 | Desk actions + learn | Edit, hold, Copy & Mark Posted, undo, reject; `clip_post`; posted text feeds the directory counts | After 5 | |
| 7 | Main | Whole flow on the test database, reviews, move to the live database, merge to `main` | Last | |

## 11. Decided

- The desk shows **every video in the day folder**, at any depth; the `x` mark is shown, not used as a filter (27 Nov 2026).
- A file not on the share is gone: not shown, not archived. A video in two day folders shows in both (27 Nov 2026).
- Today walked every 30 s, the month every 10 min, plus a Refresh button: fewer share reads, so fewer chances of a hang
  (27 Nov 2026). A share that stops answering stops the walk at once and is logged as down.
- Share root: `\\10.1.1.20\fin_data\EXPORT FOR YOUTUBE`.
- Tags and handles are part of this build (step 5), not later.

## 12. Open

- Direct posting through the X API: later, not in this build.
