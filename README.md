# backend-socia

The backend for **Socia**, 1st India News' digital desk.

**Branches:** `main` is production and holds **phase 1**. The `phase-2` branch holds the full-feature snapshot (Samvadia ingest, footage, X API posting, other platforms).

## Phase 1 at a glance

- **Source:** the newsroom's Hindi breaking-news `.txt` files on the share `\\10.1.1.19\controldata\BREAKING_TAZA_NEWS`. Read only. Today's and yesterday's folders, only BREAKING files. SCROLL and nat_flash files are skipped.
- **Parser:** reads the file name's tags (district code, BIG, UPDATE, desk, reporter, date), the place line (town) and the headline and points.
- **Post:** an X post in the First India style, e.g. `#Jodhpur #रावतभाटा: <headline>`, then the points, then `#RajasthanWithFirstIndia` and 0-2 verified handles. The whole post stays within X's weighted 280 characters.
- **Posting is by hand.** The desk clicks **Copy & Posted**, which copies the text, pastes it on X and marks the draft posted. No X API keys are needed.
- **Optional card:** **Add card** renders a card image on request. Nothing is rendered until someone asks.
- **Runs natively on Windows** on the office PC. No Docker.

## Phase switch: `PHASE`

Set `PHASE=1` on **both** the API and the worker (the same value). Any value other than `1`, `2` or empty stops startup.

| In phase 1 | Status |
|---|---|
| X API posting (Approve, Retry, Recall return 409 `phase_off`) | off |
| `publish` worker role (not started, logs an error) | off |
| Samvadia ingest (`SOURCE_MODE=samvadia` refuses to start) | off |
| Footage and photo matching | off |
| Platforms other than X (`features.platforms` is `["x"]`) | off |
| Card on demand (no card until **Add card**) | on |
| Copy & Posted (with a 5-minute undo) | on |
| Web Scraper (worker role `trends`) | on |

`GET /me` returns `phase` and `features`. The desk reads them from there; the frontend has no switch of its own.

## How a story moves (phase 1)

| Stage | What happens | Where |
|---|---|---|
| Read the share | Polls today's folder every `FTP_POLL_SECONDS` (default 5 s). A file is taken once two scans see the same size. The sha256 dedupes re-saves. Raw bytes are kept in storage. | `apps/worker/src/breaking-source.ts`, `stages/ingest.ts` |
| Parse | Tags from the file name, town from the place line, needs-check reasons (`no_district`, `no_hindi`, `very_long`, `resaved`, ...) | `packages/core/src/breaking/` (`filename.ts`, `parse.ts`) |
| Places and handles | Districts, Hindi names and towns from the data files; verified handles only | `apps/worker/config/`, `breaking/places.ts`, `breaking/handles.ts` |
| Compose | Builds the post (rules only, no LLM). The body is cut on a word with `...`; the headline is cut last | `packages/core/src/breaking/compose.ts`, `stages/compose.ts` |
| Operator | Claims the draft (5-minute lease), edits it, then **Copy & Posted** (or Reject, or leave it) | `packages/db/src/desk.ts`, `apps/api/src/routes/desk.ts` |
| Add card (optional) | The render role draws the card when asked | `apps/worker/src/card/`, `stages/render.ts` |

### The share and its folders

- Layout: `<MONTH>_<YEAR>\<DD>_<MONTH>_<YEAR>\*.txt`. Folder names are typed by hand, so they are matched loosely (`JANUARAY_2026`, `02SEPTEMBER_2026`).
- Today's and yesterday's folders are read all day (late files land in yesterday's folder).
- Only BREAKING files. SCROLL and nat_flash files are never taken.
- Files over 1 MB are skipped. A share call slower than 20 s counts as the share being down.
- The share is **read only**. Nothing is written, renamed or deleted there.
- **First start:** the worker records nothing yet, so it skips the files already on the share and takes only new ones.

### Places and handles data files

- `apps/worker/config/rajasthan-places.json`: districts, Hindi names, codes and towns.
- `apps/worker/config/district-handles.json`: the @handles. Only **verified** handles are in it. Each entry carries its source.
- Edit either file without a code change. The worker checks them at most once a minute. A broken edit keeps the last good copy and logs why.
- Override the paths with `PLACES_FILE` and `DISTRICT_HANDLES_FILE`.
- Whether each file is readable shows in `GET /ingest/status` (`dataFiles`).

### Post format

```
#Jodhpur #रावतभाटा: <headline>

<point 1>, <point 2>...

#RajasthanWithFirstIndia @<verified handle>
```

Footer is `#FirstIndiaNews` for non-Rajasthan news. Handles follow rules (district police or collector, `@RajGovOfficial`, `@BhajanlalBjp`). Never on party or election news.

## Run it on the office PC (Windows, no Docker)

**You need:** Node 22+, pnpm 10 (`corepack pnpm` works without installing it), Postgres 16+, and a Windows account that opens the share without a login prompt. If Node runs as a service, the PC's machine account needs read access instead.

1. **Install:** `corepack pnpm install`
2. **Chromium for Add card** (the render role): `corepack pnpm --filter @socia/worker exec playwright install chromium`
3. **Env file:** copy the phase 1 lines from `.env.live.example` (sections 1-3) into `.env.live`. It is gitignored. Never commit it or paste real values anywhere. Values have no quotes and no spaces around `=`.
4. **Migrate:** `node --env-file=.env.live --import tsx packages/db/scripts/migrate.ts`
5. **Org and users:** `corepack pnpm --filter @socia/api cli create-org --name "1st India News"`, then `cli create-user` (flags in `apps/api/src/cli.ts`).
6. **Build:** `corepack pnpm build`
7. **API:** `node --env-file=.env.live apps/api/dist/index.js`
8. **Worker** (one process; the ingest role is a singleton):
   `node --env-file=.env.live apps/worker/dist/index.js ingest pipeline render maintenance trends`

Do not add `publish` in phase 1.

Check it is working: open `GET /ingest/status`. `state` should be `ok`, and `source.todayFolderFound` true once the day's folder exists (a missing folder is waiting, not an error).

### Local try-out without the share

Copy a day's folders to `C:\vartmaan\code\local-dev\share-copy\BREAKING_TAZA_NEWS`. Set `SOURCE_DIR` to that path in a local `.env` (keep `PHASE=1`, `SOURCE_MODE=folder`, `SOURCE_LAYOUT=breaking`), then run steps 4, 7 and 8 above.

### Environment variables

Names only. Values go in `.env.live`. Full list with comments: `.env.live.example` and `.env.example`.

| Name | Purpose |
|---|---|
| `PHASE` | `1` on API and worker |
| `ORG_ID` | Organisation id (from `create-org`) |
| `DATABASE_URL` | Socia's Postgres |
| `SECRET_KEY` | 32 random bytes, base64. Encrypts TOTP seeds. Keep it: changing it breaks every two-step sign-in |
| `SOURCE_MODE` | `folder` in phase 1 |
| `SOURCE_LAYOUT` | `breaking` in phase 1 |
| `SOURCE_DIR` | The share root (read only) |
| `FTP_POLL_SECONDS` | Seconds between scans (default 5) |
| `PLACES_FILE`, `DISTRICT_HANDLES_FILE` | Override the data file paths |
| `WORKER_ROLES` | Phase 1: `ingest,pipeline,render,maintenance,trends` |
| `RENDER_POOL` | Chromium pages for Add card (1 is enough) |
| `PORT` | API port (8200 in the office setup) |
| `STORAGE_DIR`, `STORAGE_PUBLIC_BASE` | Where cards and files live, and the address desk browsers use for them |
| `CORS_ORIGINS` | The desk's origin(s), comma-separated |
| `COOKIE_SECURE` | `false` on plain http on the LAN |
| `SESSION_HOURS` | Session length |
| `REQUIRE_TOTP` | `true`: every user sets up an authenticator app at first login. Keep Windows time sync on |
| `TRUST_PROXY` | `false` for direct LAN access |
| `OWNER_API_KEY` | Owner console key (32+ characters). Unset: `/owner` is off |
| `LOG_LEVEL` | Log level (default info) |
| `TRENDS_*`, `REWRITE_MODE` | Web Scraper settings. `REWRITE_MODE` must stay `rules` |

Not read in phase 1: `SAMVADIA_*`, `FOOTAGE_DIR`, `FTP_*` (phase 2 only), `MEDIA_*`, `X_*`.

## Migrations

Run `node --env-file=.env.live --import tsx packages/db/scripts/migrate.ts` (or `corepack pnpm db:migrate` with `DATABASE_URL` set). Phase 1 adds:

| Migration | What it does |
|---|---|
| `0013_owner_actor` | `audit_log.actor` (text). Owner console changes are written as `owner:<name>` |
| `0014_audit_type_at_idx` | Index for the owner console's history |
| `0015_phase1_breaking` | `published_posts.platform_post_id` and `permalink` become nullable (Copy & Posted has no X id yet). New `stories` columns: `layout`, `town`, `file_tags`, `needs_check`, `desk_note` |
| `0016_phase1_review` | `stories.update_of_draft_id` (a file saved again after its post). Indexes for the share and the queue. One live Copy & Posted record per draft |

All are additive. Existing rows keep working.

### Rollback guard

The down scripts are in `packages/db/migrations/down/`. The migrator does not run them. Run them by hand, with the pre-phase-1 code deployed, newest first (0016, then 0015, and so on).

- `0016` refuses unless it is the newest applied migration.
- `0015` refuses while any story still has phase 1 data (file tags, town, desk note, needs-check reasons). To drop it anyway, set the session setting `socia.force_rollback`:
  `PGOPTIONS="-c socia.force_rollback=on" psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <down file>`
- `0013` copies each owner row's actor into the audit JSON before dropping the column.

## Owner API (`/owner`)

Used by the Sentry control centre's People page. Server to server only.

- Routes: `GET /owner/people`, `GET /owner/people/:id/permissions`, `PATCH /owner/people/:id`, `PUT /owner/people/:id/overrides`, `GET /owner/history`.
- On only when `OWNER_API_KEY` is set to 32+ characters. Otherwise every `/owner` path is a 404.
- Each call sends `Authorization: Bearer <OWNER_API_KEY>` and `X-Owner-Actor: <sentry username>` (1-64 characters: a-z, 0-9, `.`, `_`, `-`). No cookies, no CSRF.
- Wrong or missing keys are rate limited per IP. A valid key always passes.
- The last active admin cannot be disabled, demoted or lose `users.manage` or `roles.manage` (409 `last_admin`).
- Every change is audited as `owner:<name>`.

## Tests

Use the binaries in `node_modules/.bin` if `pnpm` is not on PATH.

```bash
node_modules/.bin/turbo run test --concurrency=1     # all packages, what "pnpm test" runs
cd apps/api && ../../node_modules/.bin/vitest run     # one package (use its own folder)
```

- Unit tests always run.
- Integration tests (for example `apps/api/test/phase1.test.ts`) need `TEST_DATABASE_URL`, a **throwaway** Postgres. The tests wipe it. PowerShell: `$env:TEST_DATABASE_URL = "postgresql://..."`.

## How the digital desk calls it

Every request sends cookies (`credentials: "include"`). Every POST, PATCH and DELETE also sends `X-CSRF: <csrfToken from /auth/login or /me>`.

| Screen | Calls |
|---|---|
| Sign in | `POST /auth/login {email, password}` → `next`: `totp` or `totp_setup` · `POST /auth/totp {code}` · `POST /auth/totp/setup` → QR URI, then `POST /auth/totp/enable {code}` · `GET /me` (phase, features, permissions, pages) · `POST /auth/logout` |
| X queue | `GET /x/queue?view=inbox\|posted\|sending\|rejected\|failed&before=` with filters `district`, `big`, `update`, `desk`, `needsCheck`, `days` · `GET /x/queue/facets?view=` (filter counts) · `GET /caps` |
| Draft | `GET /drafts/:id` · `POST /drafts/:id/claim` (409 names who holds it) · `POST /drafts/:id/heartbeat` every 60 s · `POST /drafts/:id/release` |
| Edit | `PATCH /drafts/:id {version, bodyText?, cardHeadline?, hashtags?, mentions?}` (409 on a stale version) · `POST /x/check` for the live counter |
| Phase 1 posting | `POST /drafts/:id/copy-posted {version}` (409 `already_posted`, `stale_version`, `held_by_other`; 422 `post_invalid`) · `POST /drafts/:id/copy-posted/undo` (within 5 minutes) · `POST /drafts/:id/card/render` ("Add card"; 429 `cooldown` after a failed render) |
| Phase 2 decisions | `POST /drafts/:id/approve {version}` · `POST /jobs/:id/undo` · `POST /drafts/:id/retry` · `POST /posts/:id/recall {reason}` (all 409 `phase_off` in phase 1) |
| Reject and restore | `POST /drafts/:id/reject {reason, note?}` · `POST /drafts/:id/restore` |
| Published | `GET /posts?before=` · `POST /drafts/:id/mark-posted` (with a permalink; phase 2) |
| Dashboard | `GET /x/counts` · `GET /ingest/status` (state, source health, data files; paths and last errors for users with Settings) |
| Library | `GET/POST/PATCH/DELETE /hashtag-rules` · `GET /handles?q=` · `POST/PATCH/DELETE /handles` · `GET /handles/staging` · `POST /handles/staging/:id/promote` · `.../dismiss` |
| Admin | `GET/POST/PATCH /users` · `GET /audit?entityType=&entityId=` |
| Live | `io(API, { withCredentials: true })`. Events include `story.arrived`, `draft.updated`, `draft.claimed`, `post.sent`, `post.cancelled`, `cap.changed`, `ingest.status`, and `resync` |

Full request and response shapes: `C:\vartmaan\code\handoff\phase1-contract.md` (phase 1) and `C:\vartmaan\code\handoff\socia-api-contract.md` (the rest). Both are outside this repo.

Reject reasons are `inaccurate`, `duplicate`, `low_quality`, `policy` and `other`. Roles: **Operator** acts on their own platforms; **Editor** acts on any platform and maintains rules and handles; **Admin** adds users; **Viewer** reads only.

## Layout

```
apps/api          Fastify API + Socket.IO. Writes rows only: never calls X, never renders.
apps/worker       One binary, roles chosen per process or Render service: ingest, pipeline, render,
                  publish, maintenance, trends, and the handles cron.
packages/core     Every pure function: breaking-news rules (breaking/), Kruti Dev, parse, slug, compose,
                  hashtags, mentions, states, caps, card fit, TOTP, phase (phase.ts). Unit tested.
packages/db       Drizzle schema + migrations (+ down/ rollbacks), desk operations, the publish outbox,
                  live events (pg_notify), audit log.
packages/providers  Storage (R2 / local), the folder or FTP source, the X client, Wikidata.
```

Phase 1 data: `apps/worker/config/*.json`.

---

## Phase 2 (off in phase 1)

Everything below is for the phase 2 line on the `phase-2` branch. With `PHASE=1` it is not read or does not run.

### Samvadia ingest and footage

- **Ingest (Samvadia):** `SOURCE_MODE=samvadia`. Every 5 s, reads stories Samvadia put in its feed (`stories.state='ready'`, originals and updates; not kills) since a stored cursor, through a read-only session. Deduped by Samvadia story id and version. Footage: lists `items.footage_path` on the FTP (list and download only), copies photos within `MEDIA_TYPES` and `MEDIA_MAX_MB`, records videos (copies them when `MEDIA_VIDEO=true`). Late footage still attaches for 30 h.
  - Files: `apps/worker/src/stages/samvadia.ts`, `packages/db/src/samvadia.ts`, `packages/providers/src/footage.ts`.
- **Kruti Dev file path** (`SOURCE_MODE=folder|ftp`, `SOURCE_LAYOUT=flat`): Kruti Dev text converted to Unicode. Line 1 is the headline, the rest is the body, with a confidence score. Files: `stages/ingest.ts`, `packages/core/src/kruti.ts`, `parse.ts`. Pairing (`packages/db/src/pipeline.ts`): a story waits up to 6 h for its media.
- **Recall and X posting:** `X_MODE=api` with the client's X app (OAuth 1.0a). Approve writes the publish job, set to run 10 s later; Undo cancels it if no worker has taken it. Publish retries with backoff and gives up after 5 attempts. Files: `apps/worker/src/stages/publish.ts`, `packages/db/src/queue.ts`, `packages/db/src/desk.ts`.
- **Samvadia's side** (the assignment desk that writes the stories) is in `C:\vartmaan\code\backend-Samvadia\README.md`.

### Phase 2 go-live steps

1. **Samvadia:** point `SAMVADIA_DATABASE_URL` at the real Samvadia database through a SELECT-only login (the SQL to create it is in `.env.live.example`). Socia opens every session read-only.
2. **FTP:** remove `FOOTAGE_DIR`; set `FTP_HOST`, `FTP_USER`, `FTP_PASSWORD`. Socia only lists and downloads.
3. **X:** `X_MODE=api` and the four OAuth 1.0a keys. Check X's current limits first; set `X_RATE_TOKENS` and `X_RATE_WINDOW_SECONDS` to match.
4. Restart the API and the worker. On the first start the Samvadia cursor reaches back `SAMVADIA_BACKFILL_HOURS` (default 24; `0` starts from now).

Set `PHASE=2` on both API and worker, add `publish` to the worker roles, and set the phase 2 variables in `.env.live.example`.

### Deploy on Render (phase 2)

`render.yaml` creates every service in the topology:

| Service | Type | Notes |
|---|---|---|
| `socia-api` | Web Service | Runs migrations before each deploy |
| `socia-ingest` | Background Worker | Singleton; also runs convert and compose |
| `socia-render` | Background Worker | Docker, on the Playwright image |
| `socia-publish` | Background Worker | Also runs housekeeping |
| `socia-cron-handles` | Cron Job | 02:00 IST |
| `socia-db` | Postgres | |
| `socia-kv` | Key Value | X token bucket |

Render has no persistent disks, so every file lives in R2. Workers finish their current job on SIGTERM, and leases expire on their own.

To reach the control-room FTP: use passive mode, pin Render's static outbound IPs, and have 1st India's IT allowlist them.

### Phase 2 notes

- **Local dev with dummy data:** `SOURCE_MODE=samvadia`, a dummy Samvadia database and a dummy FTP folder. The seed refuses anything not on localhost and Samvadia's own databases. Commands: `corepack pnpm local:migrate`, `ADMIN_DATABASE_URL=... corepack pnpm local:dev samvadia-seed`, `corepack pnpm local:dev socia-setup`, `corepack pnpm local:api`, `corepack pnpm local:worker`, `corepack pnpm local:dev samvadia-late`. `local.credentials.md` is gitignored.
- **Phase 2 posting:** Approve and Retry are on, Recall is on, and the desk shows the footage panel and other platforms.

---

## Where this differs from the architecture doc

- **Login.** Login is password + TOTP inside Fastify, with sessions in Postgres, not Auth.js. The frontend is a separate app, and Auth.js is built to live inside Next.js.
- **Live updates.** Live updates go through `pg_notify` from the same transaction as the change. Each API instance listens and pushes to its own sockets, so an event is never sent for a change that rolled back. Redis is used only for the X token bucket.
- **Ellipsis.** The ellipsis is added only when the text was actually cut. The doc's sample code always adds it.

## Not settled yet

- **Kruti Dev table (phase 2 file path): provisional.** Built from the common Kruti Dev 010 layout, not from the control room's own `.ttf`. Get the exact font and 200 real files, build the 30-file regression set, and reach at least 99% character accuracy (doc section 12 Q1).
- **X API: confirm against live docs** before `X_MODE=api`. Check the v2 media upload and `POST /2/tweets` with OAuth 1.0a, and current rate limits.
- **Card template: placeholder.** It needs the client's template, logo and licensed font, plus a visual sign-off on sample cards.
- **Hashtag script.** City tags can come out as `#जयपुर` or `#Jaipur` (the org setting `hashtagScript`). The desk still has to choose (doc section 12 Q3).
- **Hindi input.** Find out whether operators type Unicode or use the Remington layout. That decides the editor in the frontend.
