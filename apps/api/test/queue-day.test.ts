// GET /x/queue?day=YYYY-MM-DD: only stories received on that India (IST) calendar day. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { istDayStart } from "@socia/core";
import { createDb, orgs, postDrafts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { parseQueueDay } from "../src/routes/desk";

const URL_ = process.env.TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The IST calendar day `offset` days from today, as YYYY-MM-DD */
const istDay = (offset: number) => new Date(istDayStart(new Date()).getTime() + offset * DAY_MS + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

describe("parseQueueDay", () => {
  const now = new Date("2026-11-11T20:00:00Z"); // 12 Nov 01:30 IST
  it("accepts today and past IST days, and nothing when absent", () => {
    expect(parseQueueDay(undefined, now)).toBeNull();
    expect(parseQueueDay("2026-11-12", now)!.start.toISOString()).toBe("2026-11-11T18:30:00.000Z");
    expect(parseQueueDay("2026-11-11", now)!.end.toISOString()).toBe("2026-11-11T18:30:00.000Z");
  });
  it("refuses the wrong shape, impossible dates and the future with bad_day", () => {
    for (const bad of ["2026-11-13", "2026-02-30", "12-11-2026", "2026-11-1", "today"]) {
      expect(() => parseQueueDay(bad, now), bad).toThrow(expect.objectContaining({ status: 400, code: "bad_day" }));
    }
  });
});

(URL_ ? describe : describe.skip)("queue day filter", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const session = { cookie: "", csrf: "" };
  let orgId = "";
  const ids: Record<string, string> = {};

  const config: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 3).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };

  async function call(url: string) {
    const res = await app.inject({ method: "GET", url, headers: { cookie: session.cookie, "x-csrf": session.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  const names = async (q: string) => (await call(`/x/queue?${q}`)).body.items.map((i: { headline: string }) => i.headline);

  /** A story received at `receivedAt`; its draft is made at `draftAt` (the inbox's sort key) */
  async function draft(key: string, receivedAt: Date, draftAt: Date, district: string | null = null) {
    const [s] = await h.db
      .insert(stories)
      .values({ orgId, slug: key, status: "composed", headline: key, body: "", layout: "breaking", mediaState: "none", district, createdAt: receivedAt })
      .returning();
    const [row] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: s!.id, status: "ready", bodyText: key, cardHeadline: key, hashtags: [], composeVersion: "b1", cardRev: 0, createdAt: draftAt })
      .returning();
    ids[key] = row!.id;
  }

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    await h.db.insert(users).values({ orgId, name: "Op", email: "op@test", passwordHash: await hashPassword("correct horse battery"), role: "operator" });

    // Day D = 1 Nov 2026 (IST). 23:50 IST on D = 18:20 UTC; 00:10 IST on D+1 = 18:40 UTC.
    await draft("late-on-D", new Date("2026-11-01T18:20:00Z"), new Date("2026-11-01T18:21:00Z"), "Jaipur");
    await draft("early-on-D+1", new Date("2026-11-01T18:40:00Z"), new Date("2026-11-01T18:41:00Z"), "Jaipur");
    // D starts at 00:00 IST exactly (31 Oct 18:30 UTC): in; one minute earlier: out
    await draft("start-of-D", new Date("2026-10-31T18:30:00Z"), new Date("2026-10-31T18:31:00Z"), "Kota");
    await draft("end-of-D-1", new Date("2026-10-31T18:29:00Z"), new Date("2026-10-31T18:29:30Z"), "Kota");
    // A story received on D whose draft was made the next day still counts for D (the day is the story's)
    await draft("received-D-drafted-later", new Date("2026-11-01T10:00:00Z"), new Date("2026-11-02T10:00:00Z"), "Kota");
    await draft("today", new Date(), new Date());

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-qday-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config }, false);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "op@test", password: "correct horse battery" } });
    session.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    session.csrf = JSON.parse(res.body).csrfToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("puts 23:50 IST on D and 00:10 IST on D+1 in their own days, newest draft first", async () => {
    expect(await names("day=2026-11-01")).toEqual(["received-D-drafted-later", "late-on-D", "start-of-D"]);
    expect(await names("day=2026-11-02")).toEqual(["early-on-D+1"]);
    expect(await names("day=2026-10-31")).toEqual(["end-of-D-1"]);
    expect(await names("day=2026-10-30")).toEqual([]);
    expect(await names(`day=${istDay(0)}`)).toEqual(["today"]);
  });

  it("without day the queue is unchanged", async () => {
    expect(await names("")).toEqual(["today", "received-D-drafted-later", "early-on-D+1", "late-on-D", "start-of-D", "end-of-D-1"]);
  });

  it("combines with the other filters and pages within the day", async () => {
    expect(await names("day=2026-11-01&district=Kota")).toEqual(["received-D-drafted-later", "start-of-D"]);
    const first = (await call("/x/queue?view=inbox&day=2026-11-01&limit=2")).body;
    expect(first.items.map((i: { headline: string }) => i.headline)).toEqual(["received-D-drafted-later", "late-on-D"]);
    expect(first.nextCursor).not.toBeNull();
    const next = (await call(`/x/queue?view=inbox&day=2026-11-01&limit=2&before=${encodeURIComponent(first.nextCursor)}`)).body;
    expect(next.items.map((i: { headline: string }) => i.headline)).toEqual(["start-of-D"]);
    expect(next.nextCursor).toBeNull();
  });

  it("refuses a bad format, an impossible date and a future day with 400 bad_day", async () => {
    for (const bad of ["2026-11-1", "01-11-2026", "2026/11/01", "2026-02-30", "2026-13-01", istDay(1), "2026-11-01x"]) {
      const res = await call(`/x/queue?day=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error, bad).toBe("bad_day");
    }
    expect((await call("/x/queue?day=")).status).toBe(400);
  });

  it("leaves the facets alone: today counts stay today, and they take no day", async () => {
    expect((await call("/x/queue/facets")).body).toMatchObject({ total: 6, today: { total: 1 } });
    expect((await call("/x/queue/facets?day=2026-11-01")).status).toBe(400);
  });
});
