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
    .env.example                     every setting, with defaults (copy to .env: the worker, the api and media.py read it)
    src\share\rules.ts               the share layout, x / done marks, the title left in a file name (pure)
    src\worker\                      its own process: watch, probe, headline (screen read), learn
    src\headline\                    step 4's rules: the day's programme filler (lines.ts), the model's prompt and answer (model.ts)
    src\compose\compose.ts           step 5: place, channel label, hashtags and @handles around the headline (the api runs it)
    src\db\  migrations\             schema "xvideos", own migrations
    src\api\                         the desk's routes (mounted by apps/api when XVIDEOS=true)
    test\                            vitest
    media\                           the Python GPU service
      media.py                       HTTP service on 127.0.0.1:8300: /health, /screen, /speech, /read
      headline.py                    screen reading: frames, OCR, bar lines (moved in from the trial x_headline.py)
      requirements.txt               what the service needs; requirements.lock.txt pins every package as trials 4-5 ran
      setup.ps1  setup_models.py     build digital\x-requirements on a new machine (§9)
      test_headline.py               headline.py's text rules (unittest)
    directory\                       the X video tag and handle directory (§5)
      format.json tags.json handles.json     built files, read by the composer
      build.py eval.py                       build it, test it (collect.py, gathering new #FINVideo posts: step 2, later)
      data\finvideo-posts.jsonl              the desk's published #FINVideo posts

  x-requirements\                    NOT in git (it sits beside the backend and frontend repos, in neither): the heavy, machine-specific files
    env\                             Python 3.12 venv for media\ (GPU Paddle, faster-whisper), about 4 GB
    models\paddle\official_models\   PaddleOCR detection + Devanagari recognition (about 0.1 GB)
    models\whisper\large-v3\         faster-whisper large-v3 (about 2.9 GB; the speech fallback uses it too, so no medium)
    cache\                           spare (posters, stills and the screen read's temp frames go to XVIDEOS_CACHE)

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
| 4 | Screen read | Only when step 3 finds no heading: `POST /screen` on the media service, the day's programme filler dropped, `POST /speech` when under 2 bar lines are left, qwen3:14b writes the headline (§4.2). | `src/worker/headline.ts`, `src/headline/`, `media/headline.py` | Built (`XVIDEOS_HEADLINE`) |
| 5 | Compose | Place, channel label (`\| Jaipur News`), then tags and handles from the directory (§5), each on (emit) or offered (suggest). The desk adds the brand tag and `#FINVideo`. Composed when the desk reads a clip, so it always uses the current directory. | `src/compose/compose.ts` | Built |
| 6 | Desk | Shows **every video in the chosen day folder**, with its inner folder and its `x` / done mark shown on the row. Opens on **today's day folder only** (IST), not yesterday's. A month / day selector outside the clip list picks another day. Save a draft, hold, Copy & Mark Posted, undo (6 min), reject, restore (§8). | `src/api/` + frontend | Built (backend); the desk still keeps actions in its own state until it is wired to the routes |
| 7 | Learn | Every 10 min, posts past their undo window go into the desk's post list (each once) and `build.py` rebuilds the directory from the captures and them into a new folder under `XVIDEOS_CACHE\directory\builds`; the one-line `current` file switches to it in one rename, and the composer follows (§5). It also rebuilds when the committed captures, `build.py` or the breaking desk's files change. A failed build changes nothing and its posts wait. | `src/worker/learn.ts` + `directory/build.py` | Built |

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

Media service (`POST /screen`, `media/headline.py`):

1. ffmpeg: one frame every 3 s over the first 75 s, scaled to 1280 wide.
2. Frames grouped by the picture of the red headline bar (one group per bar line).
3. PaddleOCR 3.x on the GPU (`PP-OCRv5_mobile_det` + `devanagari_PP-OCRv5_mobile_rec`), fixed screen regions only: the bar
   in every frame, the place tag and the right panel once per group.
4. Bar lines: the words of the bar joined left to right, logo bits dropped, the most typical reading of each line kept (vote),
   half-drawn and repeated lines removed.

Worker (`src/worker/headline.ts`):

5. The day's programme filler is dropped (fixes A and C below, `src/headline/lines.ts`).
6. Speech only as a fallback: when fewer than 2 bar lines are left (vertical shorts, programme clips), `POST /speech` reads
   the first 45 s with the Whisper large-v3 the service already holds.
7. qwen3:14b (Ollama, `think: false`, JSON) writes the headline, the place and topic hashtags (`src/headline/model.ts`).
   The headline is the desk's suggestion ("Read from the screen: check it"); place and topics wait for step 5.

The screen read is kept (`clip_screen`), so asking the model again never re-reads the video. A clip whose name gets a
heading first is skipped; when the service or Ollama is down clips wait without using a try; after 3 failed tries the
clip is still ready on the desk, only without a suggestion. Clips read before step 4 existed are queued once (days still
on the share, newest first).

| Measured on | Clips | Median time | Word match with the desk | Place suffix right |
|---|---|---|---|---|
| 21 Nov (tuned on) | 26 | 2.8 s | 0.46 (was 0.39 at 68 s) | 15/26 |
| 27 Nov (held out) | 29 | 3.6 s (1080p) | 0.37: normal news 0.45, election clips 0.23 | 8/29 exact, 15/29 place named |
| 27 Nov (held out), step 4 as built: fixes A + C, speech for programme clips | 29 | | **0.55**: normal 0.50, election **0.65** (the trial scored the same way: 0.39, 0.49, 0.24) | step 5 |

**Programme bar (day-2 check, built):** on election days a programme bar ("गांव की पंचायत") repeats the same 4 general lines
on every clip with the programme's name glued to the front ("गांव की 37 जिलों की 419 ..."), and the clip's own result is
only in the right panel.

- (A) A bar line seen on 3+ of the day's screen-read clips is programme filler and dropped, **when it starts with the
  programme's name**.
- (C) The programme's name is cut from the front of the clip's other bar lines. It is found, not listed: the 2 leading
  words that 3+ different repeated lines start with ("गांव की" on 27 Nov). One word is not a name: three repeated stories
  that all start "राजस्थान ..." keep it.
- Apart from the programme: the BREAKING NEWS logo read as text ("RPEAKINC NEAS") is dropped from any clip (a Latin-only
  line 0.55+ like "breaking news"; real English bar lines stay).
- Why the guard in A: the same story copied onto 3 clips (27 Nov: the NABARD conclave, posted 3 times) repeats its own
  lines on 3 clips too, but they start with different words, so they stay.
- The first two clips of a programme are read before it can be seen. When a later clip shows it, the day's clips whose
  lines change are written again (the model only).

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
`#FINVideo` 100 %, brand 96 %, place tag found 83 % (right 68 %), collector 92 %, police 62 %, people / parties / offices
37 %, topic tags found 5 % and right 48 % (797 of 1,039 tags were used once: the model suggests those). To be re-run once
`collect.py` has gathered a few more days of live posts.

**The composer** (`src/compose/compose.ts`, built 27 Nov 2026) is `eval.py`'s predictor with the mix that measured best:
tags from the video directory (`tags.json`, campaign patterns inside their own dates), handles from the breaking desk's
whole directory. It gives the same numbers as `eval.py` on the same posts. On the desk:

| Part | On or offered | From |
|---|---|---|
| Place tag (`#Jaipur`, the form the desk uses now) | on | the title's ` \| …` ending, then the headline, then the model's place for a screen read |
| District police handle | on when the title is about a crime | `district-handles.json` |
| `#RajasthanNews` | offered (right 59 % when added on its own) | `format.json` |
| Topic, person, party, campaign tags | offered | `tags.json` keywords and patterns; the model's topic tags for a screen read |
| People, parties, offices, collectors | offered | the breaking desk's handles, by name and keyword |
| Reporter handles | offered | only the file's own name, never the title |
| Channel label | the title's ending | the file name's own ending, else `<District> News`, `Rajasthan News`, or `<State> News` / `India News` outside Rajasthan (region `india`) |

The directory files are reloaded when they change and composes are cached per clip, so the desk's list costs nothing
after the first read (178 clips of 27 Nov: 45 ms).

---

## 6. Media service (`media/`, Python, the GPU)

One process holds the GPU (OCR and Whisper large-v3 loaded once, one request on the GPU at a time). It reads only under
the share and writes only under `XVIDEOS_CACHE`.

| Route | Does |
|---|---|
| `GET /health` | OCR and Whisper loaded or not, load errors, the screen read's version |
| `POST /screen` | Step 4 (§4.2, 1-4): bar lines with their time on screen, other screen text, timings (2-4 s) |
| `POST /speech` | Step 4's fallback: the anchor's words over the first 45 s (Whisper large-v3, batched) |
| `POST /read` | Speech of the whole clip, scene cuts, stills (built; off unless `XVIDEOS_SPEECH=on`) |

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
| `clip_job` | Work queue (probe, read, headline), lease, attempts | Built |
| `clip_evidence` | What `/read` found: transcript, cuts, stills | Built |
| `clip_screen` | Step 4: the screen read (bar lines, other text, the anchor's words when read) and the model's headline with how it was made (lines used, filler dropped, place, topics) | Built |
| `clip_draft` | The editor's saved draft (title, tags, handles, trim as the desk keeps it) and who holds the clip | Built |
| `clip_post` | The desk's decisions: posted (the text copied to X, title, tags, handles) or rejected (reason), by whom, when, undone, learned. At most one stands per clip (unique index), so two editors cannot post a clip twice | Built |
| `scan_request` | The desk's Refresh requests (one per day), taken by the watcher | Built |

---

## 8. API (`XVIDEOS=true`, same sign-in as the desk)

| Route | Does | State |
|---|---|---|
| `GET /xvideos/clips?day=&status=` | Every video of one day folder; without `day`, **today's (IST) only**. `suggestedHeadline` is the file name's heading, else the model's (`headlineSource` `file_name` / `screen`); `district`, `region`, `channelLabel`, `hashtags` and `mentions` (`{value, on, why}`) are composed around it (§5) | Built |
| `GET /xvideos/folders` | Today and every day whose folder holds videos, grouped by month, with counts (videos, x-marked, done), for the desk's month / day selector | Built |
| `POST /xvideos/rescan?day=` | The desk's Refresh: the watcher walks that day (default today) within seconds, and again 10 s later so new files settle | Built |
| `GET /xvideos/clips/:id` · `/video` · `/poster` · `/frames/:name` | One clip, the video with byte ranges, stills | Built |
| `PUT` · `DELETE /xvideos/clips/:id/draft` | Save the editor's draft / back to the suggestion | Built |
| `POST /xvideos/clips/:id/hold` `{held}` | Hold the clip ("on it", the desk shows who) or let it go; anyone may take a hold over | Built |
| `POST /xvideos/clips/:id/posted` `{text, title, hashtags, mentions}` | Copy & Mark Posted; 409 when the clip is already posted or rejected | Built |
| `POST /xvideos/clips/:id/undo` `{postId}` | Undo that post within 6 min (409 after, or when a newer post replaced it) | Built |
| `POST /xvideos/clips/:id/reject` `{reason}` · `restore` | Reject with a reason; bring it back | Built |

Each action needs the X desk's own permission for it, as the X post desk does: `draft.edit` (draft, hold),
`post.mark_posted`, `post.undo`, `draft.reject` (reject, restore). A clip already posted or rejected, or marked done on the
share, takes no new decision, draft or hold (409); a file gone from the share cannot be posted.

Every action answers with the clip as the desk now shows it (`status` posted / rejected / new, `postId`, `postedAt`, `postedText`,
`postedBy`, `rejectedReason`, `heldBy`, `draft`). A file marked done on the share counts as posted when the desk has no
decision of its own.

---

## 9. A new machine

```
git clone … ; cd digital\backend ; corepack pnpm install
powershell -File apps\xvideos\media\setup.ps1 [-Clip <video>]
                                                   builds digital\x-requirements: venv, pinned models (copied from this
                                                   PC's caches when there), ollama pull qwen3:14b, then checks OCR and
                                                   Whisper load on the GPU and reads the screen of -Clip
copy apps\xvideos\.env.example to apps\xvideos\.env     fill DATABASE_URL, ORG_ID, XVIDEOS_MEDIA_KEY
pnpm --filter @socia/xvideos migrate
```

Running (PowerShell; Git Bash cannot see the share):

```
pnpm --filter @socia/xvideos worker                watch, probe, headline (needs the media service and Ollama), learn
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
| 3 | Day folder + file-name title | Month + day scan at any depth, all videos, IST date; `GET /xvideos/folders`; `GET /xvideos/clips?day=` (today by default); title from the file name; desk: month / day selector, `x` mark and inner folder on each row | After 1 | Built (27 Nov 2026) |
| 4 | Screen read | `x-requirements` + `setup.ps1`; `headline.py` (trial flow); `/screen` + `/speech`; programme-bar fix A, C in the worker; headline job only for clips whose name has no heading | After 3 | Built (27 Nov 2026) |
| 5 | Tags and handles | Directory built from the 427 saved `#FINVideo` posts (9 Sep-27 Nov 2026); `compose.ts` (place, label, tags, handles, emit / suggest) on the desk's reads; campaign patterns kept with their own dates | After 4 | Built (27 Nov 2026) |
| 6 | Desk actions + learn | Draft (`clip_draft`), hold, Copy & Mark Posted, undo, reject, restore (`clip_post`); learn rebuilds the directory from the desk's posts | After 5 | Built, backend (27 Nov 2026); the desk is wired to these routes in step 7 |
| 7 | Main | Wire the desk's actions to the step 6 routes; whole flow on the test database, reviews, move to the live database, merge to `main` | Last | |

## 11. Decided

- The desk shows **every video in the day folder**, at any depth; the `x` mark is shown, not used as a filter (27 Nov 2026).
- A file not on the share is gone: not shown, not archived. A video in two day folders shows in both (27 Nov 2026).
- Today walked every 30 s, the month every 10 min, plus a Refresh button: fewer share reads, so fewer chances of a hang
  (27 Nov 2026). A share that stops answering stops the walk at once and is logged as down.
- Share root: `\\10.1.1.20\fin_data\EXPORT FOR YOUTUBE`.
- Tags and handles are part of this build (step 5), not later.

## 12. Open

- Direct posting through the X API: later, not in this build.
