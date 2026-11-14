// The editor's @ / # lookup (desk fixes 14 Nov, point 7): exact prefix, verified only, known sources only.
// The pure parts run always; the route needs TEST_DATABASE_URL.

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, handleDirectory, hashtagRules, orgs, runMigrations, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { DISTRICT_HANDLES_FILE, REPORTER_HANDLES_FILE, SUBJECT_HANDLES_FILE } from "../src/handle-keywords";
import {
  HANDLE_SEARCH_LIMIT, PARTY_HANDLES_FILE, PLACES_FILE, fileHandleEntries, mergeResults, placeTagEntries, prefixPattern, searchEntries, searchQuery,
} from "../src/handle-search";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const values = (items: { value: string }[]) => items.map((i) => i.value);

describe("handle search: the pure parts", () => {
  it("drops the leading @ or #, any case, NFC", () => {
    expect(searchQuery("@Jai")).toBe("jai");
    expect(searchQuery("  ##JAIPUR ")).toBe("jaipur");
    expect(searchQuery("@")).toBe("");
    expect(searchQuery(undefined)).toBe("");
    expect(searchQuery("जय".normalize("NFD"))).toBe("जय".normalize("NFC"));
  });

  it("escapes LIKE wildcards in the prefix pattern", () => {
    expect(prefixPattern("a_b%c\\")).toBe("a\\_b\\%c\\\\%");
  });

  it("matches from the start only: a handle, a name, a Hindi name, an alias", () => {
    const entries = fileHandleEntries({
      subject: { entries: [
        { handle: "@BhajanlalBjp", name: "Bhajanlal Sharma", names_en: ["Bhajanlal Sharma", "CM Bhajanlal"], names_hi: ["भजनलाल शर्मा"], verified: true },
        { handle: "@UnverifiedOne", names_en: ["Bhajan Mandal"], verified: false },
      ] },
    });
    expect(values(searchEntries(entries, "bhajan"))).toEqual(["@BhajanlalBjp"]); // the unverified one never
    expect(values(searchEntries(entries, "भजन"))).toEqual(["@BhajanlalBjp"]);
    expect(values(searchEntries(entries, "cm bh"))).toEqual(["@BhajanlalBjp"]);
    expect(values(searchEntries(entries, "sharma"))).toEqual([]); // not from the middle
    expect(values(searchEntries(entries, "lalbjp"))).toEqual([]);
  });

  it("reads the real handle files: verified district handles by district name", async () => {
    const entries = fileHandleEntries({
      district: await readJson(DISTRICT_HANDLES_FILE), subject: await readJson(SUBJECT_HANDLES_FILE),
      reporter: await readJson(REPORTER_HANDLES_FILE), party: await readJson(PARTY_HANDLES_FILE),
    });
    const jaipur = searchEntries(entries, "jaipur");
    expect(jaipur.length).toBeGreaterThan(0);
    expect(jaipur.length).toBeLessThanOrEqual(HANDLE_SEARCH_LIMIT);
    expect(values(searchEntries(entries, "bjp4raj"))).toEqual(["@BJP4Rajasthan"]);
    for (const e of entries) expect(e.item.value).toMatch(/^@\w{1,15}$/);
  });

  it("place tags: a district's Latin tag, its Hindi name, a town's tag", async () => {
    const entries = placeTagEntries(await readJson(PLACES_FILE));
    expect(values(searchEntries(entries, "jaipu"))).toEqual(["#Jaipur"]);
    expect(values(searchEntries(entries, "जयपु"))).toContain("#जयपुर");
    expect(values(searchEntries(entries, "किशन"))).toContain("#किशनगढ़");
    expect(searchEntries(entries, "xyzzy")).toEqual([]);
    expect(placeTagEntries(null)).toEqual([]);
  });

  it("merges the directory first, each value once in any case, capped", () => {
    const item = (value: string, source: "directory" | "file") => ({ value, name: value, nameHi: null, source });
    expect(mergeResults([item("@A", "directory")], [item("@a", "file"), item("@B", "file")])).toEqual([item("@A", "directory"), item("@B", "file")]);
    expect(mergeResults(Array.from({ length: 12 }, (_, i) => item(`@h${i}`, "directory")), [])).toHaveLength(HANDLE_SEARCH_LIMIT);
  });
});

const URL_ = process.env.TEST_DATABASE_URL;

(URL_ ? describe : describe.skip)("GET /handles?mode=prefix", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const op = { cookie: "", csrf: "" };
  const config: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 5).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url, headers: { cookie: op.cookie, "x-csrf": op.csrf } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db.insert(orgs).values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } }).returning();
    const orgId = org!.id;
    await h.db.insert(users).values({ orgId, name: "Op", email: "op@test", passwordHash: await hashPassword("correct horse battery"), role: "operator" });
    const now = new Date();
    await h.db.insert(handleDirectory).values([
      { orgId, entityName: "Ramesh Meena", entityNameHi: "रमेश मीणा", aliases: ["आरएम जी"], handle: "rm_writes", source: "manual", verifiedAt: now },
      { orgId, entityName: "Sanganer Airport", aliases: [], handle: "@SanganerAirpt", source: "wikidata:Q1", verifiedAt: now },
      { orgId, entityName: "Ramesh Pending", aliases: [], handle: "RameshPending", source: "manual", verifiedAt: null },
      { orgId, entityName: "100% Pure_Name", aliases: [], handle: "PureName", source: "manual", verifiedAt: now },
    ]);
    await h.db.insert(hashtagRules).values({ orgId, matchType: "entity", name: "Panchayat election", aliases: [], hashtagLatin: "PanchayatChunav", hashtagDevanagari: "पंचायतचुनाव", priority: 5 });
    app = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-hsearch-")), "http://localhost/dev-files"), config }, false);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "op@test", password: "correct horse battery" } });
    op.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    op.csrf = JSON.parse(res.body).csrfToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("@: verified rows by handle, name, Hindi name or alias prefix; never unverified, never mid-word", async () => {
    expect(values((await get("/handles?mode=prefix&kind=mention&q=%40rm_")).body.items)).toEqual(["@rm_writes"]);
    expect(values((await get(`/handles?mode=prefix&kind=mention&q=${encodeURIComponent("रमेश")}`)).body.items)).toEqual(["@rm_writes"]);
    expect(values((await get(`/handles?mode=prefix&kind=mention&q=${encodeURIComponent("आरएम")}`)).body.items)).toEqual(["@rm_writes"]);
    expect(values((await get("/handles?mode=prefix&kind=mention&q=RAMESH")).body.items)).toEqual(["@rm_writes"]);
    expect(values((await get("/handles?mode=prefix&kind=mention&q=sangan")).body.items)).toEqual(["@SanganerAirpt"]);
    expect((await get("/handles?mode=prefix&kind=mention&q=meena")).body.items).toEqual([]);
    expect((await get("/handles?mode=prefix&kind=mention&q=%25")).body.items).toEqual([]); // a % is a letter, not a wildcard
  });

  it("@: also the verified handles of the data files, after the directory", async () => {
    const items = (await get("/handles?mode=prefix&kind=mention&q=BJP4Raj")).body.items;
    expect(values(items)).toEqual(["@BJP4Rajasthan"]);
    expect(items[0].source).toBe("file");
  });

  it("#: place tags and the org's hashtag rules, by prefix", async () => {
    expect(values((await get("/handles?mode=prefix&kind=hashtag&q=%23Jaipu")).body.items)).toEqual(["#Jaipur"]);
    expect(values((await get("/handles?mode=prefix&kind=hashtag&q=panch")).body.items)).toEqual(["#PanchayatChunav"]);
    expect(values((await get(`/handles?mode=prefix&kind=hashtag&q=${encodeURIComponent("पंचायत")}`)).body.items)).toContain("#पंचायतचुनाव");
  });

  it("an empty query is no results; without mode the Settings list is unchanged", async () => {
    expect((await get("/handles?mode=prefix&q=%40")).body.items).toEqual([]);
    expect((await get("/handles?mode=nope")).status).toBe(400);
    expect((await get("/handles?q=Meena")).body.items.map((r: { handle: string }) => r.handle)).toEqual(["rm_writes"]);
  });
});
