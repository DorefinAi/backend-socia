# backend-socia

The backend for **Socia**, 1st India News' digital desk. It takes control-room stories from the FTP share and turns them into X posts. Each post gets a rendered card and needs one operator click to go out.

Phase 1 is **deterministic only**: no LLM, no GPU, no image-generation API. It covers X only; Instagram, Facebook and video come later. It is built from *Socia — Phase 1 Backend Architecture v1.0* (17 Oct 2026), and the *Socia spec v1.1* remains the long-term contract.

![System map](docs/diagrams/socia-system-map.png)

## How a story moves

![Story path](docs/diagrams/socia-story-path.png)

| Stage | What happens | Where |
|---|---|---|
| Ingest | Polls the share every 5 s. A file is taken once two scans 2 s apart see the same size. The sha256 dedupes re-saves, and the raw bytes are kept in storage | `apps/worker/src/stages/ingest.ts` |
| Convert + parse | Kruti Dev → Unicode, then line 1 is the headline and the rest is the body, with a confidence score | `packages/core/src/kruti.ts`, `parse.ts` |
| Pair | Text and media share a slug. Either can arrive first, a story waits up to 6 h for media, and late media still attaches | `packages/db/src/pipeline.ts` |
| Compose | Pure rules: cut to about 9 words, keep within X's weighted 280, then city hashtags and fixed hashtags. @mentions are suggestions only | `packages/core/src/compose.ts` |
| Render | HTML card, auto-fit by binary search in Chromium, PNG to storage. Runs before anyone opens the draft | `apps/worker/src/card/`, `stages/render.ts` |
| Operator | Claims a 5-minute lease, edits (a stale version gets 409), then approves, rejects or leaves | `packages/db/src/desk.ts`, `apps/api/src/routes/desk.ts` |
| Outbox | Approve writes the publish job in the same transaction, set to run 10 s later. Undo cancels it if no worker has taken it yet | `desk.ts` `approveDraft`, `undoPost` |
| Publish | Takes a rate token, gets the card, uploads media, creates the post, records the id, verifies, then marks success. Retries with backoff and gives up after 5 attempts | `apps/worker/src/stages/publish.ts`, `packages/db/src/queue.ts` |
| Recall, metrics | Recall deletes on X and is logged with its reason. Metrics are pulled every 6 h in batches of 100 | `stages/publish.ts`, `stages/crons.ts` |

What an operator does in a shift:

![User flow](docs/diagrams/socia-user-flow.png)

## Layout

```
apps/api          Fastify API + Socket.IO. Writes rows only: never calls X, never renders.
apps/worker       One binary, roles chosen per Render service: ingest, pipeline, render, publish,
                  maintenance, and the metrics / handles crons.
packages/core     Every pure function: Kruti Dev, parse, slug, compose, hashtags, mentions,
                  states, caps, card fit, TOTP. Unit tested; the API uses it for live checks.
packages/db       Drizzle schema + migrations, desk operations (claim, approve, undo, recall),
                  the publish outbox, live events (pg_notify), audit log.
packages/providers  Storage (R2 / local), the FTP or folder source, the X client, Wikidata.
```

## Run it locally

You need Node 22+, pnpm 10 and Postgres 16.

```bash
pnpm install
pnpm --filter @socia/worker exec playwright install chromium
cp .env.example .env          # fill in DATABASE_URL and SECRET_KEY; leave X_MODE=fake
pnpm db:migrate
pnpm --filter @socia/api cli create-org --name "1st India News"         # prints ORG_ID; put it in .env
pnpm --filter @socia/api cli create-user --org <ORG_ID> --email you@example.com --name You --role admin --password '<10+ chars>'
pnpm --filter @socia/api dev                                              # API on :4000
pnpm --filter @socia/worker dev ingest pipeline render publish maintenance
```

Drop a `.txt` file into `SOURCE_DIR`. Within a few seconds it is a ready draft with a card. With `X_MODE=fake`, posting only records a fake id and nothing reaches X.

### Tests

```bash
pnpm test                       # unit tests always run
TEST_DATABASE_URL=postgresql://... pnpm test   # integration tests too; that database is wiped
```

The integration tests run on real Postgres and real Chromium. They cover:

- claim leases: one operator per draft, and the 409 on a stale save
- the 10 s undo, and refusing undo once a worker has taken the job
- daily caps
- retries, dead jobs, and rate limits that do not use up an attempt
- reconciliation after a worker crash, so nothing posts twice
- recall
- events sent only when the change commits
- the full path from a Kruti Dev file in a folder to a post on the fake X client
- sign-in with TOTP, and CSRF
- role limits
- a live Socket.IO event

## How the digital desk calls it

Every request sends cookies (`credentials: "include"`). Every POST, PATCH and DELETE also sends `X-CSRF: <csrfToken from /auth/login or /me>`.

| Screen | Calls |
|---|---|
| Sign in | `POST /auth/login {email, password}` → `next`: `totp` or `totp_setup` · `POST /auth/totp {code}` · `POST /auth/totp/setup` → QR URI, then `POST /auth/totp/enable {code}` · `GET /me` · `POST /auth/logout` |
| X queue | `GET /x/queue?view=inbox\|sending\|rejected\|failed&before=` (each item has its card URL, the claim holder, and flags) · `GET /caps` |
| Draft | `GET /drafts/:id` · `POST /drafts/:id/claim` (409 names who holds it) · `POST /drafts/:id/heartbeat` every 60 s · `POST /drafts/:id/release` |
| Edit | `PATCH /drafts/:id {version, bodyText?, cardHeadline?, hashtags?, mentions?}` (409 on a stale version, with the current copy) · `POST /x/check` for the live counter |
| Decide | `POST /drafts/:id/approve {version}` → `{jobId, sendAt}` · `POST /jobs/:id/undo` · `POST /drafts/:id/reject {reason, note?}` · `POST /drafts/:id/restore` · `POST /drafts/:id/retry` |
| Published | `GET /posts?before=` (with metrics) · `POST /posts/:id/recall {reason}` |
| Library | `GET/POST/PATCH/DELETE /hashtag-rules` · `GET /handles?q=` (the @ picker) · `POST/PATCH/DELETE /handles` · `GET /handles/staging` · `POST /handles/staging/:id/promote` · `.../dismiss` |
| Admin | `GET/POST/PATCH /users` · `GET /audit?entityType=&entityId=` |
| Live | `io(API, { withCredentials: true })`. Events: `story.arrived`, `draft.updated`, `draft.claimed`, `draft.released`, `post.queued`, `post.cancelled`, `post.sent`, `post.failed`, `post.recalled`, `cap.changed`, and `resync` (refetch everything) |

Reject reasons are `inaccurate`, `duplicate`, `low_quality`, `policy` and `other`. Roles work like this:

- **Operator:** acts on their own platforms, and posts directly.
- **Editor:** acts on any platform, and also maintains hashtag rules and handles.
- **Admin:** everything an editor can do, plus users.
- **Viewer:** read only.

## Deploy on Render

`render.yaml` creates every service in the doc's topology:

| Service | Type | Notes |
|---|---|---|
| `socia-api` | Web Service | Runs migrations before each deploy |
| `socia-ingest` | Background Worker | Singleton; also runs convert and compose |
| `socia-render` | Background Worker | Docker, on the Playwright image |
| `socia-publish` | Background Worker | Also runs housekeeping |
| `socia-cron-metrics` | Cron Job | Every 6 h |
| `socia-cron-handles` | Cron Job | 02:00 IST |
| `socia-db` | Postgres | |
| `socia-kv` | Key Value | X token bucket |

Fill in the `sync: false` values when Render asks. Render has no persistent disks, so every file lives in R2. Workers finish their current job on SIGTERM, and leases expire on their own, so a deploy mid-job is safe.

To reach the control-room FTP: use passive mode, pin Render's static outbound IPs, and have 1st India's IT allowlist them.

## Where this differs from the architecture doc

- **Login.** Login is password + TOTP inside Fastify, with sessions in Postgres, not Auth.js. The frontend is a separate app, and Auth.js is built to live inside Next.js.
- **Live updates.** Live updates go through `pg_notify` from the same transaction as the change. Each API instance listens and pushes to its own sockets, so an event is never sent for a change that rolled back. Redis is used only for the X token bucket.
- **Ellipsis.** The ellipsis is added only when the text was actually cut. The doc's sample code always adds it.

## Not settled yet

- **Kruti Dev table: provisional.** It is built from the common Kruti Dev 010 layout, not from the control room's own `.ttf`. Get the exact font and 200 real files, build the 30-file regression set, and reach ≥99% character accuracy before trusting anything downstream (doc §12 Q1).
- **X API: confirm against live docs.** Check the v2 media upload and `POST /2/tweets` with OAuth 1.0a before switching to `X_MODE=api`. Check current rate limits too, and set `X_RATE_TOKENS` / `X_RATE_WINDOW_SECONDS` to match. The doc warns that X has changed this surface repeatedly.
- **Card template: placeholder.** It needs the client's template, logo and licensed font, plus a visual sign-off on sample cards.
- **Hashtag script.** City tags can come out as `#जयपुर` or `#Jaipur` (the org setting `hashtagScript`); the desk still has to choose (doc §12 Q3).
- **Hindi input.** Find out whether operators type Unicode or on the Remington layout. That decides the editor in the frontend, not the backend.
