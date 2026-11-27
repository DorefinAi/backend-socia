// The X Videos queries and routes against a real Postgres: the local test copy named in apps/xvideos/.env (never the
// live database "socia"). Skipped when no .env / DATABASE_URL is there. Rows use the year 1999 so they can never
// meet a real clip, and are removed before and after; a real Refresh request waiting in the table is put back.
// Run with the X Videos worker stopped: a running watcher would mark the 1999 test month gone mid-test.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { createDb, type Db } from "@socia/db";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { xvideosRoutes } from "../src/api/routes";
import {
  xvDecide,
  xvReleasePosts,
  xvTakePostsToLearn,
  xvSaveDraft,
  xvSetHold,
  xvUndoDecision,
  xvDayScreens,
  xvDeferJob,
  xvFailJob,
  xvFinishJob,
  xvListClips,
  xvListDays,
  xvLiveMonths,
  xvMarkGone,
  xvMarkGoneDays,
  xvQueueMissingHeadlines,
  xvRecordScan,
  xvRedoStep,
  xvRequestScan,
  xvSaveHeadline,
  xvSaveScreenRead,
  xvTakeScanRequests,
  type XvSeenFile,
} from "../src/db/clips";
import type { XvHeadlineResult, XvScreenRead } from "../src/db/schema";
import { xvWireClip } from "../src/api/view";
import { runXvMigrations, XV_LIVE_DB } from "../src/db/migrate";
import { xvToday } from "../src/share/rules";

const ENV = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(ENV) && !process.env.DATABASE_URL) process.loadEnvFile(ENV);
const url = process.env.DATABASE_URL;
const orgId = process.env.ORG_ID ?? "";

const MONTH = ["1999", "JANUARY 1999"] as const;
const file = (dayNum: number, name: string, size: number, inner: string[] = []): XvSeenFile => {
  const dd = String(dayNum).padStart(2, "0");
  return {
    folder: [...MONTH, `${dd}-01-1999`, ...inner],
    fileName: name,
    size,
    mtime: new Date(size * 1000),
    fingerprint: `${size}:${size * 1000}`,
    picked: name.startsWith("x"),
    done: false,
    title: name,
    day: `1999-01-${dd}`,
    heading: null,
  };
};

describe.skipIf(!url || !orgId)("X Videos database (test copy)", () => {
  let db: Db;
  let close: () => Promise<void>;
  /** xvTakeScanRequests for the tests' own (1999) days: any real request it also took is put back */
  const takeOwn = async () => {
    const taken = await xvTakeScanRequests(db, orgId);
    for (const day of taken.filter((d) => d >= "2000-01-01")) await xvRequestScan(db, orgId, day);
    return taken.filter((d) => d < "2000-01-01");
  };
  const clean = async () => {
    await db.execute(sql`delete from xvideos.clip where org_id = ${orgId} and folder[1] = '1999'`);
    await db.execute(sql`delete from xvideos.scan_request where org_id = ${orgId} and day < '2000-01-01'`);
  };

  beforeAll(async () => {
    ({ db, close } = createDb(url!, 2));
    const name = (await db.execute<{ name: string }>(sql`select current_database() as name`)).rows[0]?.name;
    if (name === XV_LIVE_DB) throw new Error("db.test.ts never runs on the live database");
    await runXvMigrations(url!);
    await clean();
  });
  afterAll(async () => {
    if (!db) return;
    await clean();
    await close();
  });

  it("records every video once per day: a rename updates the row, a copy in another day is that day's own clip", async () => {
    const first = await xvRecordScan(db, orgId, [file(1, "x...a.mp4", 101), file(1, "b.mp4", 102, ["Convert 1 pm"])]);
    expect(first).toEqual({ inserted: 2, queued: 2 });
    const renamed = await xvRecordScan(db, orgId, [file(1, "x...done...a.mp4", 101)]);
    expect(renamed.inserted).toBe(0);
    const copy = await xvRecordScan(db, orgId, [file(2, "x...a.mp4", 101)]);
    expect(copy).toEqual({ inserted: 1, queued: 1 });

    const day1 = await xvListClips(db, orgId, { day: "1999-01-01" });
    expect(day1.map(({ clip: c }) => [c.fileName, c.status, c.folder.slice(3).join("/")]).sort()).toEqual([
      ["b.mp4", "reading", "Convert 1 pm"],
      ["x...done...a.mp4", "reading", ""],
    ]);
    expect((await xvListClips(db, orgId, { day: "1999-01-02" })).map(({ clip: c }) => c.fileName)).toEqual(["x...a.mp4"]);
  });

  it("lists the days that hold videos, with counts; a day whose files are all gone is not listed", async () => {
    const days = (await xvListDays(db, orgId)).filter((d) => d.day < "2000-01-01");
    expect(days).toEqual([
      { day: "1999-01-02", clips: 1, picked: 1, done: 0 },
      { day: "1999-01-01", clips: 2, picked: 1, done: 0 },
    ]);
    expect(await xvLiveMonths(db, orgId)).toContainEqual([...MONTH]);

    // b.mp4 left 1 Jan's folder; then the whole 2 Jan folder went
    expect(await xvMarkGone(db, orgId, [...MONTH, "01-01-1999"], ["101:101000"])).toBe(1);
    expect(await xvMarkGoneDays(db, orgId, MONTH, ["01-01-1999"])).toBe(1);
    expect((await xvListDays(db, orgId)).filter((d) => d.day < "2000-01-01")).toEqual([{ day: "1999-01-01", clips: 1, picked: 1, done: 0 }]);
    expect((await xvListClips(db, orgId, { day: "1999-01-02" })).map(({ clip: c }) => c.status)).toEqual(["gone"]);

    // The month folder is gone: everything left in it goes
    expect(await xvMarkGoneDays(db, orgId, MONTH, [])).toBe(1);
    expect(await xvLiveMonths(db, orgId)).not.toContainEqual([...MONTH]);

    // A file back on the share comes back
    await xvRecordScan(db, orgId, [file(1, "b.mp4", 102)]);
    const onDesk = await xvListClips(db, orgId, { day: "1999-01-01", statuses: ["seen", "reading", "new", "failed"] });
    expect(onDesk.map(({ clip: c }) => [c.fileName, c.status])).toEqual([["b.mp4", "reading"]]);
  });

  it("keeps one Refresh request per day and hands each out once", async () => {
    await xvRequestScan(db, orgId, "1999-01-01");
    await xvRequestScan(db, orgId, "1999-01-02");
    await xvRequestScan(db, orgId, "1999-01-01");
    expect((await takeOwn()).sort()).toEqual(["1999-01-01", "1999-01-02"]);
    expect(await takeOwn()).toEqual([]);
  });

  describe("routes", () => {
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    beforeAll(async () => {
      app.setValidatorCompiler(TypeBoxValidatorCompiler);
      await app.register(xvideosRoutes, {
        db,
        viewer: () => ({ orgId }),
        httpError: (status, code, message) => Object.assign(new Error(message), { statusCode: status, code }),
        shareRoot: "S:\\none",
        cacheDir: "S:\\none",
      });
    });
    afterAll(() => app.close());

    it("GET /xvideos/clips?day= lists that day's videos with the desk's fields", async () => {
      const res = await app.inject({ method: "GET", url: "/xvideos/clips?day=1999-01-01" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.day).toBe("1999-01-01");
      expect(body.clips.map((c: { fileName: string; picked: boolean; innerFolder: string }) => [c.fileName, c.picked, c.innerFolder])).toEqual([["b.mp4", false, ""]]);
    });

    it("GET /xvideos/clips without a day is today's (IST) folder", async () => {
      const res = await app.inject({ method: "GET", url: "/xvideos/clips" });
      expect(res.statusCode).toBe(200);
      expect(res.json().day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("refuses a day that is not a date, and an unknown status", async () => {
      for (const q of ["day=1999-02-31", "day=01-01-1999", "day=1999-01-01&status=bogus"]) {
        expect((await app.inject({ method: "GET", url: `/xvideos/clips?${q}` })).statusCode).toBe(400);
      }
    });

    it("GET /xvideos/folders gives today and the days holding videos, grouped by month", async () => {
      const res = await app.inject({ method: "GET", url: "/xvideos/folders" });
      expect(res.statusCode).toBe(200);
      const { today, months } = res.json() as { today: string; months: { month: string; days: { day: string; clips: number }[] }[] };
      const days = months.flatMap((m) => m.days);
      expect(days.some((d) => d.day === today)).toBe(true);
      expect(months.find((m) => m.month === "1999-01")?.days).toEqual([{ day: "1999-01-01", clips: 1, picked: 0, done: 0 }]);
      expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort().reverse());
    });

    it("POST /xvideos/rescan asks the watcher for a day (today by default)", async () => {
      const res = await app.inject({ method: "POST", url: "/xvideos/rescan?day=1999-01-02" });
      expect(res.json()).toEqual({ day: "1999-01-02", requested: true });
      expect((await app.inject({ method: "POST", url: "/xvideos/rescan?day=1999-13-01" })).statusCode).toBe(400);
      expect(await takeOwn()).toEqual(["1999-01-02"]);
      // Without a day: today's folder. Its request is removed again unless one was already waiting.
      const day = xvToday(new Date());
      const waiting = (await db.execute(sql`select 1 from xvideos.scan_request where org_id = ${orgId} and day = ${day}`)).rows.length > 0;
      const today = await app.inject({ method: "POST", url: "/xvideos/rescan" });
      expect(today.json()).toEqual({ day, requested: true });
      if (!waiting) await db.execute(sql`delete from xvideos.scan_request where org_id = ${orgId} and day = ${day}`);
    });
  });

  // Step 4. Runs after the routes (which count 1999's days). Jobs are moved by hand, never claimed: a claim could take a
  // real clip's job from the queue.
  describe("step 4: headline jobs and screen reads", () => {
    const D = "1999-01-05";
    const read = (lines: string[]): XvScreenRead => ({ tookS: 1, durationS: 30, barLines: lines.map((text) => ({ text, secs: 3, firstS: 1 })), otherText: [], timings: { framesS: 1, ocrS: 1 }, speech: null });
    const result = (linesUsed: string[]): XvHeadlineResult => ({ model: "m", tookS: 1, tokensOut: 1, placeHindi: "", district: "", state: "", topicHashtags: [], linesUsed, dropped: [], usedSpeech: false });
    const id: Record<string, string> = {};
    const job = async (name: string, step: string) =>
      (await db.execute<{ id: number; status: string; attempts: number }>(sql`select j.id, j.status, j.attempts from xvideos.clip_job j where j.clip_id = ${id[name]} and j.step = ${step}`)).rows[0];
    const clipOf = async (name: string) => (await db.execute<{ status: string; error: string | null }>(sql`select status, error from xvideos.clip where id = ${id[name]}`)).rows[0];
    /** Puts a job in the hands of a worker whose lease ends at `lease` */
    const hold = async (name: string, step: string, lease: Date, attempts: number) => {
      const j = (await job(name, step))!;
      await db.execute(sql`update xvideos.clip_job set status = 'running', lease_until = ${lease.toISOString()}, attempts = ${attempts} where id = ${j.id}`);
      return { id: Number(j.id), clipId: id[name]!, leaseUntil: lease, attempts, step: step as "headline" };
    };
    const LEASE = new Date("2030-01-01T00:00:00.123Z");

    beforeAll(async () => {
      await xvRecordScan(db, orgId, [file(5, "a5.mp4", 501), file(5, "b5.mp4", 502), file(5, "c5.mp4", 503), { ...file(5, "named.mp4", 504), heading: "पाँच शब्दों वाली पूरी हेडिंग" }]);
      const rows = (await db.execute<{ id: string; file_name: string }>(sql`select id, file_name from xvideos.clip where org_id = ${orgId} and day = ${D}`)).rows;
      for (const r of rows) id[r.file_name.replace(".mp4", "")] = r.id;
      // Probed: ready on the desk, no headline yet
      await db.execute(sql`update xvideos.clip_job set status = 'done' where clip_id in (select id from xvideos.clip where org_id = ${orgId} and day = ${D})`);
      await db.execute(sql`update xvideos.clip set status = 'new' where org_id = ${orgId} and day = ${D}`);
    });

    it("queues the headline once for ready clips whose name holds none, newest file first, and leaves them on the desk", async () => {
      expect(await xvQueueMissingHeadlines(db, orgId, D, { untilDay: D })).toBe(3);
      expect(await xvQueueMissingHeadlines(db, orgId, D, { untilDay: D })).toBe(0);
      expect(await job("named", "headline")).toBeUndefined();
      const order = (await db.execute<{ file_name: string }>(sql`select c.file_name from xvideos.clip_job j join xvideos.clip c on c.id = j.clip_id where c.day = ${D} and j.step = 'headline' order by j.next_attempt_at`)).rows;
      expect(order.map((r) => r.file_name)).toEqual(["c5.mp4", "b5.mp4", "a5.mp4"]);
      expect((await clipOf("a5"))?.status).toBe("new");
    });

    it("keeps screen reads by day, with where each clip's headline job stands", async () => {
      await xvSaveScreenRead(db, id.a5!, "xvs-1", read(["गांव की पहली लाइन"]));
      await xvSaveScreenRead(db, id.b5!, "xvs-1", read(["दूसरी क्लिप की लाइन"]));
      const day = await xvDayScreens(db, orgId, D);
      expect(day.map((d) => [d.clipId, d.jobStatus, d.read.barLines[0]?.text]).sort()).toEqual(
        [[id.a5, "pending", "गांव की पहली लाइन"], [id.b5, "pending", "दूसरी क्लिप की लाइन"]].sort(),
      );
      await expect(xvSaveHeadline(db, id.c5!, "x", result([]))).rejects.toThrow(/no screen read/);
    });

    it("saves the headline only while the lease holds, and the desk shows it as read from the screen", async () => {
      const held = await hold("a5", "headline", LEASE, 1);
      expect(await xvFinishJob(db, { ...held, leaseUntil: new Date(LEASE.getTime() + 1) }, null, (tx) => xvSaveHeadline(tx, id.a5!, "पुरानी दौड़", result([])))).toBe(false);
      expect(await xvFinishJob(db, held, null, (tx) => xvSaveHeadline(tx, id.a5!, "स्क्रीन से हेडलाइन", result(["पहली लाइन"])))).toBe(true);
      expect((await job("a5", "headline"))?.status).toBe("done");
      const listed = (await xvListClips(db, orgId, { day: D })).map((r) => xvWireClip(r, null, false));
      const wire = Object.fromEntries(listed.map((w) => [w.fileName, [w.suggestedHeadline, w.headlineSource]]));
      expect(wire["a5.mp4"]).toEqual(["स्क्रीन से हेडलाइन", "screen"]);
      expect(wire["named.mp4"]).toEqual(["पाँच शब्दों वाली पूरी हेडिंग", "file_name"]);
      expect(wire["c5.mp4"]).toEqual([null, null]);
    });

    it("redoes a finished headline: the job is pending again with its tries reset, the clip stays ready", async () => {
      expect(await xvRedoStep(db, [id.a5!, id.b5!], "headline")).toBe(1);
      expect(await job("a5", "headline")).toMatchObject({ status: "pending", attempts: 0 });
      expect((await clipOf("a5"))?.status).toBe("new");
    });

    it("a defer counts the try only when asked", async () => {
      await xvDeferJob(db, await hold("b5", "headline", LEASE, 2), 60, "down");
      expect((await job("b5", "headline"))?.attempts).toBe(1);
      await xvDeferJob(db, await hold("b5", "headline", LEASE, 2), 60, "file missing", { countTry: true });
      expect((await job("b5", "headline"))?.attempts).toBe(2);
    });

    it("a headline that fails for good leaves the clip ready; a probe that fails for good fails it", async () => {
      expect(await xvFailJob(db, await hold("b5", "headline", LEASE, 3), "headline: no answer")).toBe("failed");
      expect(await clipOf("b5")).toEqual({ status: "new", error: "headline: no answer" });
      expect(await xvFailJob(db, { ...(await hold("c5", "probe", LEASE, 3)), step: "probe" }, "probe: bad file")).toBe("failed");
      expect((await clipOf("c5"))?.status).toBe("failed");
    });

    it("a clip back on the share takes the state its jobs say: a failed headline still means ready", async () => {
      expect(await xvMarkGone(db, orgId, [...MONTH, "05-01-1999"], [])).toBe(4);
      await xvRecordScan(db, orgId, [file(5, "b5.mp4", 502), file(5, "c5.mp4", 503)]);
      expect((await clipOf("b5"))?.status).toBe("new");
      expect((await clipOf("c5"))?.status).toBe("failed");
    });
  });

  // Step 6: the desk's drafts, holds and decisions, in the queries and through the routes
  describe("step 6: drafts, holds, posted, undo, reject, restore", () => {
    const D6 = "1999-01-06";
    const OTHER_ORG = "00000000-0000-4000-8000-0000000000ff";
    const RAVI = "11111111-2222-4333-8444-555555555555";
    const id: Record<string, string> = {};
    const asha = { id: null, name: "Asha" };
    const needs: (string | undefined)[] = [];
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    beforeAll(async () => {
      await xvRecordScan(db, orgId, [file(6, "p6.mp4", 601), file(6, "q6.mp4", 602), file(6, "r6.mp4", 603), file(6, "s6.mp4", 604), { ...file(6, "x...done...t6.mp4", 605), done: true }]);
      for (const r of (await db.execute<{ id: string; file_name: string }>(sql`select id, file_name from xvideos.clip where org_id = ${orgId} and day = ${D6}`)).rows) {
        id[r.file_name.replace(".mp4", "").replace("x...done...", "")] = r.id;
      }
      app.setValidatorCompiler(TypeBoxValidatorCompiler);
      await app.register(xvideosRoutes, {
        db,
        // The header picks another org, to try reaching a clip that is not the viewer's
        viewer: (req, need) => {
          needs.push(need);
          return { orgId: req.headers["x-org"] === "other" ? OTHER_ORG : orgId, userId: RAVI, userName: "Ravi" };
        },
        httpError: (status, code, message) => Object.assign(new Error(message), { statusCode: status, code }),
        shareRoot: "S:\\none",
        cacheDir: "S:\\none",
      });
    });
    afterAll(() => app.close());
    const draft = { title: "हेडलाइन | Kota News", brandOn: true, hashtags: [{ value: "#Kota", on: true }], mentions: [], trim: { start: 0, end: 30 } };
    const standingOf = async (clipId: string) =>
      (await db.execute<{ id: string; action: string; by: string | null }>(sql`select id, action, by from xvideos.clip_post where clip_id = ${clipId} and undone_at is null`)).rows;

    it("one decision stands per clip, also when two editors act at once", async () => {
      const both = await Promise.all([xvDecide(db, orgId, id.p6!, { action: "posted", text: "एक" }, asha), xvDecide(db, orgId, id.p6!, { action: "posted", text: "दो" }, asha)]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(await xvDecide(db, orgId, id.p6!, { action: "rejected", reason: "x" }, asha)).toBeNull();
      expect(await xvDecide(db, OTHER_ORG, id.q6!, { action: "posted", text: "x" }, asha)).toBeNull();
      expect(await xvUndoDecision(db, orgId, id.p6!, "rejected", asha)).toBe("none");
      const postId = Number((await standingOf(id.p6!))[0]!.id);
      expect(await xvUndoDecision(db, OTHER_ORG, id.p6!, "posted", asha, { withinS: 360 })).toBe("none");
      expect(await xvUndoDecision(db, orgId, id.p6!, "posted", asha, { postId: postId + 999, withinS: 360 })).toBe("none");
      expect(await xvUndoDecision(db, orgId, id.p6!, "posted", asha, { postId, withinS: 360 })).toBe("undone");
      expect(await xvDecide(db, orgId, id.p6!, { action: "rejected", reason: "Not news" }, asha)).toMatchObject({ action: "rejected" });
      expect(await xvUndoDecision(db, orgId, id.p6!, "rejected", asha)).toBe("undone");
    });

    it("a post can be undone only inside the window", async () => {
      await xvDecide(db, orgId, id.q6!, { action: "posted", text: "क्यू" }, asha);
      await db.execute(sql`update xvideos.clip_post set at = now() - interval '10 minutes' where clip_id = ${id.q6} and undone_at is null`);
      expect(await xvUndoDecision(db, orgId, id.q6!, "posted", asha, { withinS: 360 })).toBe("too_late");
    });

    it("learn takes standing posts past the window once, and can give them back", async () => {
      const mine = <T extends { clipId: string }>(rows: T[]) => rows.filter((p) => p.clipId === id.q6);
      const taken = mine(await xvTakePostsToLearn(db, orgId, 420));
      expect(taken.map((p) => p.text)).toEqual(["क्यू"]);
      expect(mine(await xvTakePostsToLearn(db, orgId, 420))).toEqual([]);
      await xvReleasePosts(db, taken.map((p) => p.id));
      expect(mine(await xvTakePostsToLearn(db, orgId, 420))).toHaveLength(1);
      // An undone post is never taken
      expect((await xvTakePostsToLearn(db, orgId, 0)).some((p) => p.clipId === id.p6)).toBe(false);
    });

    it("draft and hold are kept for the org's clips only, and a decision lets the hold go", async () => {
      expect(await xvSaveDraft(db, OTHER_ORG, id.r6!, draft, asha)).toBe(false);
      expect(await xvSaveDraft(db, orgId, id.r6!, draft, asha)).toBe(true);
      await xvSetHold(db, orgId, id.r6!, true, asha);
      const [row] = (await xvListClips(db, orgId, { day: D6 })).filter((r) => r.clip.id === id.r6);
      expect(row?.desk).toMatchObject({ draft, heldByName: "Asha" });
      await xvDecide(db, orgId, id.r6!, { action: "posted", text: "आर" }, asha);
      const [after] = (await xvListClips(db, orgId, { day: D6 })).filter((r) => r.clip.id === id.r6);
      expect(after?.desk).toMatchObject({ draft, heldByName: null });
      expect(after?.decision).toMatchObject({ action: "posted", text: "आर", byName: "Asha" });
      expect(await xvUndoDecision(db, orgId, id.r6!, "posted", asha, { withinS: 360 })).toBe("undone");
      // Letting go of a clip nobody holds writes no row
      await xvSetHold(db, orgId, id.s6!, false, asha);
      expect((await db.execute(sql`select 1 from xvideos.clip_draft where clip_id = ${id.s6}`)).rows).toHaveLength(0);
    });

    it("the routes: draft, hold, posted, a second post refused, undo by post id, reject, restore", async () => {
      const at = (path: string) => `/xvideos/clips/${id.r6}/${path}`;
      needs.length = 0;
      const put = await app.inject({ method: "PUT", url: at("draft"), payload: { draft } });
      expect(put.statusCode).toBe(200);
      expect(put.json().clip).toMatchObject({ draft, status: "new" });
      expect((await app.inject({ method: "POST", url: at("hold"), payload: { held: true } })).json().clip.heldBy).toBe("Ravi");
      const posted = await app.inject({ method: "POST", url: at("posted"), payload: { text: "हेडलाइन | Kota News #RajasthanWithFirstIndia #FINVideo #Kota", title: "हेडलाइन | Kota News", hashtags: ["#Kota"], mentions: [] } });
      expect(posted.statusCode).toBe(200);
      const clip = posted.json().clip;
      expect(clip).toMatchObject({ status: "posted", postedBy: "Ravi" });
      expect(clip.heldBy).toBeUndefined();
      expect((await standingOf(id.r6!))[0]?.by).toBe(RAVI);
      const again = await app.inject({ method: "POST", url: at("posted"), payload: { text: "again" } });
      expect([again.statusCode, again.json().message]).toEqual([409, "Already posted by Ravi."]);
      expect((await app.inject({ method: "PUT", url: at("draft"), payload: { draft } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: at("undo"), payload: { postId: clip.postId + 999 } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: at("undo"), payload: { postId: clip.postId } })).json().clip.status).toBe("new");
      expect((await app.inject({ method: "POST", url: at("undo"), payload: { postId: clip.postId } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: at("restore") })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: at("reject"), payload: { reason: "Poor video or sound" } })).json().clip).toMatchObject({ status: "rejected", rejectedReason: "Poor video or sound" });
      expect((await app.inject({ method: "POST", url: at("restore") })).json().clip.status).toBe("new");
      expect((await app.inject({ method: "DELETE", url: at("draft") })).json().clip.draft).toBeUndefined();
      expect(needs).toEqual(["draft.edit", "draft.edit", "post.mark_posted", "post.mark_posted", "draft.edit", "post.undo", "post.undo", "post.undo", "draft.reject", "draft.reject", "draft.reject", "draft.edit"]);
    });

    it("the routes refuse: another org's clip, a post too late to undo, a clip done on the share, bad input", async () => {
      const other = await app.inject({ method: "POST", url: `/xvideos/clips/${id.s6}/hold`, headers: { "x-org": "other" }, payload: { held: true } });
      expect(other.statusCode).toBe(404);
      const late = (await standingOf(id.q6!))[0]!;
      const tooLate = await app.inject({ method: "POST", url: `/xvideos/clips/${id.q6}/undo`, payload: { postId: Number(late.id) } });
      expect([tooLate.statusCode, tooLate.json().message]).toEqual([409, "A post can be undone for 6 minutes only; delete it on X and mark the clip again if needed."]);
      const done = await app.inject({ method: "POST", url: `/xvideos/clips/${id.t6}/posted`, payload: { text: "x" } });
      expect([done.statusCode, done.json().message]).toEqual([409, "Already posted by hand (the file is marked done on the share)."]);
      const s6 = (path: string) => `/xvideos/clips/${id.s6}/${path}`;
      expect((await app.inject({ method: "POST", url: s6("posted"), payload: { text: "   " } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: s6("posted"), payload: { text: "x", hashtags: ["#two words"] } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: s6("reject"), payload: { reason: " " } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: s6("draft"), payload: { draft: { ...draft, extra: 1 } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: s6("draft"), payload: { draft: { ...draft, trim: { start: 20, end: 10 } } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: s6("draft"), payload: { draft: { ...draft, mentions: [{ value: "@a\nb", on: true }] } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/xvideos/clips/00000000-0000-4000-8000-000000000000/hold", payload: { held: true } })).statusCode).toBe(404);
    });
  });
});
