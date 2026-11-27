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
import { xvListClips, xvListDays, xvLiveMonths, xvMarkGone, xvMarkGoneDays, xvRecordScan, xvRequestScan, xvTakeScanRequests, type XvSeenFile } from "../src/db/clips";
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
    expect(day1.map((c) => [c.fileName, c.status, c.folder.slice(3).join("/")]).sort()).toEqual([
      ["b.mp4", "reading", "Convert 1 pm"],
      ["x...done...a.mp4", "reading", ""],
    ]);
    expect((await xvListClips(db, orgId, { day: "1999-01-02" })).map((c) => c.fileName)).toEqual(["x...a.mp4"]);
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
    expect((await xvListClips(db, orgId, { day: "1999-01-02" })).map((c) => c.status)).toEqual(["gone"]);

    // The month folder is gone: everything left in it goes
    expect(await xvMarkGoneDays(db, orgId, MONTH, [])).toBe(1);
    expect(await xvLiveMonths(db, orgId)).not.toContainEqual([...MONTH]);

    // A file back on the share comes back
    await xvRecordScan(db, orgId, [file(1, "b.mp4", 102)]);
    const onDesk = await xvListClips(db, orgId, { day: "1999-01-01", statuses: ["seen", "reading", "new", "failed"] });
    expect(onDesk.map((c) => [c.fileName, c.status])).toEqual([["b.mp4", "reading"]]);
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
});
