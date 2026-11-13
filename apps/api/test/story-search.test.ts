// GET /search/stories: Hindi, Roman Hindi and English queries over story_search (built by the worker's sweep,
// syncStorySearch here), desk stories only (with an X post draft). Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORY_LINK_DAYS, storyLinkName } from "@socia/core";
import { createDb, orgs, postDrafts, runMigrations, stories, storySearch, syncStorySearch, users, type DbHandle, type StoryStatus } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { STORY_SEARCHES_PER_MINUTE } from "../src/routes/search";

const URL_ = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Item {
  id: string;
  headline: string | null;
  snippet: string | null;
  district: string | null;
  town: string | null;
  status: string;
  receivedAt: string;
  linkSlug: string | null;
  match: "text" | "phonetic" | "translated";
}

(URL_ ? describe : describe.skip)("story search", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let slowApp: Awaited<ReturnType<typeof buildApp>>;
  const session = { cookie: "", csrf: "" };
  const otherSession = { cookie: "", csrf: "" };
  let orgId = "";
  let otherOrgId = "";
  const ids: Record<string, string> = {};
  const T = new Date(Date.now() - 3 * HOUR);

  const base: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 3).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };
  const settings = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

  async function call(url: string, s = session, a = app) {
    const res = await a.inject({ method: "GET", url, headers: { cookie: s.cookie, "x-csrf": s.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  const search = async (q: string, extra = "", s = session) => {
    const r = await call(`/search/stories?q=${encodeURIComponent(q)}${extra}`, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { items: Item[]; expanded: string[] };
  };
  const idsOf = (items: Item[]) => items.map((i) => i.id);
  const found = async (q: string, s = session) => idsOf((await search(q, "", s)).items);

  async function signIn(a: typeof app, s: typeof session, email: string) {
    const res = await a.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    s.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    s.csrf = JSON.parse(res.body).csrfToken;
  }

  type StoryIn = { district: string | null; town?: string | null; headline: string | null; body: string; createdAt: Date; status?: StoryStatus };
  /** A story; with an X post draft (a desk story) unless draft is null */
  async function story(key: string, org: string, s: StoryIn, draft: string | null = "ready") {
    const [row] = await h.db
      .insert(stories)
      .values({ orgId: org, slug: key, status: s.status ?? "composed", layout: "breaking", mediaState: "none", town: s.town ?? null, district: s.district, headline: s.headline, body: s.body, createdAt: s.createdAt })
      .returning();
    ids[key] = row!.id;
    if (draft) {
      await h.db.insert(postDrafts).values({ orgId: org, storyId: row!.id, status: draft, bodyText: key, cardHeadline: key, hashtags: [], composeVersion: "b1", cardRev: 0 });
    }
  }

  const crash: StoryIn = {
    district: "Jaipur", town: "सांगानेर", createdAt: new Date(T.getTime() - HOUR),
    headline: "जयपुर: सड़क हादसे में दो की मौत",
    body: "टोंक रोड पर देर रात ट्रक और कार की भिड़ंत हुई। पुलिस ने मामला दर्ज कर जांच शुरू कर दी है। घायलों को एसएमएस अस्पताल भेजा गया।",
  };
  const flood: StoryIn = {
    district: "Banswara", createdAt: T, status: "converted",
    headline: "बांसवाड़ा में बाढ़ जैसे हालात",
    body: "लगातार बारिश से माही बांध के गेट खोले गए। निचले इलाकों में पानी भर गया।",
  };
  const cmStory: StoryIn = {
    district: "Jaipur", createdAt: T,
    headline: "मुख्यमंत्री ने नए ट्रॉमा वार्ड का लोकार्पण किया",
    body: `${"राजधानी में आज कई कार्यक्रम हुए और अधिकारी मौजूद रहे। ".repeat(4)}मुख्यमंत्री ने कहा कि सड़क दुर्घटना में घायलों का इलाज अब तेजी से होगा।`,
  };
  const fire: StoryIn = { district: "Kota", createdAt: T, headline: "कोटा: अस्पताल में आग", body: "आग पर दमकल ने काबू पाया।" };
  const govt: StoryIn = { district: null, createdAt: T, headline: "राज्य सरकार ने पुलिस भर्ती की तारीख घोषित की", body: "सरकार ने कहा कि मतदान के बाद परीक्षा होगी।" };
  const bridge: StoryIn = { district: null, createdAt: new Date(T.getTime() - 2 * HOUR), headline: "नदी में तेज बहाव", body: "गांव के पास नदी पर बना पुल टूट गया।" };
  const old: StoryIn = { district: "Ajmer", createdAt: new Date(T.getTime() - (STORY_LINK_DAYS + 5) * DAY), headline: "अजमेर में पुरानी खबर", body: "दरगाह में उर्स।" };
  const noDraft: StoryIn = { district: "Jaipur", createdAt: T, headline: "जयपुर में बिना ड्राफ्ट की खबर", body: "यह डेस्क पर नहीं है।" };
  const noHeadline: StoryIn = { district: null, createdAt: T, headline: null, body: "", status: "failed" };
  const otherOrg: StoryIn = { district: "Jaipur", createdAt: T, headline: "जयपुर में हादसा", body: "दूसरे संस्थान की खबर" };

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db.insert(orgs).values({ name: "1st India", settings }).returning();
    const [other] = await h.db.insert(orgs).values({ name: "Other newsroom", settings }).returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    const pw = await hashPassword("correct horse battery");
    await h.db.insert(users).values([
      { orgId, name: "Op", email: "op@test", passwordHash: pw, role: "operator" },
      { orgId, name: "Op Two", email: "op2@test", passwordHash: pw, role: "operator" },
      { orgId, name: "Viewer", email: "viewer@test", passwordHash: pw, role: "viewer" },
      { orgId, name: "Busy", email: "busy@test", passwordHash: pw, role: "operator" },
      { orgId: otherOrgId, name: "Other Op", email: "other@test", passwordHash: pw, role: "operator" },
    ]);
    await story("crash", orgId, crash, "published");
    await story("flood", orgId, flood);
    await story("cm", orgId, cmStory);
    await story("fire", orgId, fire);
    await story("govt", orgId, govt);
    await story("bridge", orgId, bridge);
    await story("old", orgId, old);
    await story("no-draft", orgId, noDraft, null);
    await story("no-headline", orgId, noHeadline, null);
    await story("other", otherOrgId, otherOrg);

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-search-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config: base }, false);
    slowApp = await buildApp({ db: h.db, storage: store, config: base, searchTimeoutMs: 300 }, false);
    await signIn(app, session, "op@test");
    await signIn(app, otherSession, "other@test");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await slowApp?.close();
    await h?.close();
  });

  it("the sweep indexes every story once, then has nothing to do", async () => {
    expect(await call("/search/stories?q=jaipur").then((r) => r.body.items)).toEqual([]);
    expect(await syncStorySearch(h.db)).toEqual({ candidates: 10, written: 10, skipped: 0, locked: false });
    expect(await syncStorySearch(h.db)).toEqual({ candidates: 0, written: 0, skipped: 0, locked: false });
    const [row] = await h.db.select().from(storySearch).where(eq(storySearch.storyId, ids.crash!));
    expect(row).toMatchObject({ orgId, headlineKey: " jaipur sadak hadse men do ki maut ", createdAt: crash.createdAt });
    expect(row!.searchText.startsWith(" जयपुर सडक हादसे")).toBe(true);
    expect(row!.searchText.endsWith(" सांगानेर jaipur ")).toBe(true);
  });

  it("only one sweep at a time: a second one skips while the lock is held", async () => {
    const holder = await h.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(7302025)");
      expect(await syncStorySearch(h.db)).toEqual({ candidates: 0, written: 0, skipped: 0, locked: true });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("jaipur, jaypur, JAIPUR and जयपुर find the org's Jaipur desk stories, a headline hit first", async () => {
    for (const q of ["jaipur", "jaypur", "JAIPUR", "जयपुर"]) expect(await found(q), q).toEqual([ids.crash, ids.cm]);
    const { items, expanded } = await search("jaipur");
    expect(items.map((i) => i.match)).toEqual(["text", "text"]);
    expect(expanded).toEqual(["जयपुर"]);
    expect((await search("जयपुर")).expanded).toEqual(["Jaipur"]);
    // Roman spelling not typed as the district: found by the key, still the district's forms
    expect((await search("jaypur")).items[0]!.match).toBe("translated");
  });

  it("desk stories only: a story with no X post draft is never returned", async () => {
    expect(await found("बिना ड्राफ्ट")).toEqual([]);
    expect(await found("jaipur")).not.toContain(ids["no-draft"]);
  });

  it("each item has the contract's fields; status is the X draft's", async () => {
    const crashItem = (await search("jaipur")).items[0]!;
    expect(crashItem).toEqual({
      id: ids.crash,
      headline: crash.headline,
      snippet: crash.body.normalize("NFC"),
      district: "Jaipur",
      town: "सांगानेर",
      status: "published",
      receivedAt: crash.createdAt.toISOString(),
      linkSlug: storyLinkName({ district: "Jaipur", headline: crash.headline, receivedAt: crash.createdAt }).linkSlug,
      match: "text",
    });
    // stories.status is "converted"; the item says what the desk sees: the draft's status
    expect((await search("banswara")).items[0]).toMatchObject({ id: ids.flood, status: "ready" });
  });

  it(`no link for a story older than ${STORY_LINK_DAYS} days (drafts/resolve cannot open it)`, async () => {
    const { items } = await search("ajmer");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: ids.old, linkSlug: null });
    expect((await search("jaipur")).items.every((i) => typeof i.linkSlug === "string")).toBe(true);
  });

  it("Roman Hindi: hadsa / haadsa find हादसे; baadh finds बाढ़", async () => {
    // hadsa is the glossary's Roman spelling of the accident entry: हादसे (headline) first, then दुर्घटना (body)
    for (const q of ["hadsa", "haadsa"]) {
      const { items, expanded } = await search(q);
      expect(idsOf(items), q).toEqual([ids.crash, ids.cm]);
      expect(items[0]!.match).toBe("translated");
      expect(expanded).toEqual(expect.arrayContaining(["हादसा", "दुर्घटना"]));
    }
    expect(await found("baadh")).toEqual([ids.flood]);
  });

  it("English through the glossary: accident finds हादसे (headline) above दुर्घटना (body), with a snippet at the match", async () => {
    const { items, expanded } = await search("accident");
    expect(idsOf(items)).toEqual([ids.crash, ids.cm]);
    expect(items.every((i) => i.match === "translated")).toBe(true);
    expect(expanded).toEqual(expect.arrayContaining(["दुर्घटना", "हादसा"]));
    expect(items[1]!.snippet).toContain("दुर्घटना");
    expect(items[1]!.snippet!.startsWith("…")).toBe(true);
    expect(await found("fire")).toEqual([ids.fire]);
    expect(await found("hospital")).toEqual([ids.fire, ids.crash]);
    expect(await found("floods")).toEqual([ids.flood]);
  });

  it("filler words are dropped: accident in jaipur, road accident at jaipur, accident of truck; 'of' alone still runs", async () => {
    expect(await found("accident in jaipur")).toEqual([ids.crash, ids.cm]);
    expect(await found("road accident at jaipur")).toContain(ids.crash);
    expect(await found("accident of truck")).toEqual([ids.crash]);
    expect((await call("/search/stories?q=of")).status).toBe(200);
  });

  it("short glossary forms match whole words only: bridge is not पुलिस, car is not सरकार", async () => {
    expect(await found("bridge")).toEqual([ids.bridge]);
    expect(await found("car")).toEqual([ids.crash]);
    expect(await found("police")).toEqual([ids.govt, ids.crash]);
    expect(await found("government")).toEqual([ids.govt]);
  });

  it("a short typed word: a whole-word hit (पुल) ranks above a word-start one (पुलिस)", async () => {
    const order = await found("पुल");
    // The headline hit (पुलिस भर्ती) still leads; among body hits the whole word wins
    expect(order).toContain(ids.bridge);
    expect(order).toContain(ids.crash);
    expect(order.indexOf(ids.bridge!)).toBeLessThan(order.indexOf(ids.crash!));
  });

  it("districts by any name: banswara, बांसवाडा and बांसवाड़ा", async () => {
    for (const q of ["banswara", "बांसवाडा", "बांसवाड़ा", "Banswara"]) expect(await found(q), q).toEqual([ids.flood]);
  });

  it("every word must match: jaipur हादसा, police jaipur", async () => {
    expect(await found("jaipur हादसा")).toEqual([ids.crash]);
    expect(await found("police jaipur")).toEqual([ids.crash]);
    expect(await found("kota हादसा")).toEqual([]);
  });

  it("only the user's org", async () => {
    expect(await found("जयपुर हादसा", otherSession)).toEqual([ids.other]);
    expect(await found("सांगानेर", otherSession)).toEqual([]);
  });

  it("limit, and nothing to search", async () => {
    expect((await search("jaipur", "&limit=1")).items).toHaveLength(1);
    expect(await search("a")).toEqual({ items: [], expanded: [] });
    expect(await search("%_ !")).toEqual({ items: [], expanded: [] });
  });

  it("an edited story is found by its new words after the next (recent-only) sweep", async () => {
    const op2 = { cookie: "", csrf: "" };
    await signIn(app, op2, "op2@test");
    await h.db.update(stories).set({ headline: "उदयपुर में तेंदुआ दिखा", updatedAt: sql`now()` }).where(eq(stories.id, ids.fire!));
    expect(await syncStorySearch(h.db, { sinceMinutes: 15 })).toMatchObject({ candidates: 1, written: 1 });
    expect(await syncStorySearch(h.db)).toMatchObject({ candidates: 0 });
    expect(await found("leopard", op2)).toEqual([ids.fire]);
    expect(await found("tendua", op2)).toEqual([ids.fire]);
    // The old headline's words are gone from the index (the district is still Kota)
    const kota = await search("कोटा", "", op2);
    expect(idsOf(kota.items)).toEqual([ids.fire]);
    expect(kota.items[0]!.headline).toBe("उदयपुर में तेंदुआ दिखा");
    expect(await found("अस्पताल", op2)).toEqual([ids.crash]);
  });

  it("a search that runs past its statement timeout is a 503 search_timeout", async () => {
    const op2 = { cookie: "", csrf: "" };
    await signIn(slowApp, op2, "op2@test");
    const holder = await h.pool.connect();
    try {
      // The search waits on this lock until its 300 ms statement timeout fires
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE story_search IN ACCESS EXCLUSIVE MODE");
      const r = await call("/search/stories?q=jaipur", op2, slowApp);
      expect(r).toEqual({ status: 503, body: { error: "search_timeout", message: "That search took too long. Add another word to narrow it." } });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await call("/search/stories?q=jaipur", op2, slowApp)).status).toBe(200);
  });

  it("any signed-in user may search (as the queue); signed out is a 401", async () => {
    const viewer = { cookie: "", csrf: "" };
    await signIn(app, viewer, "viewer@test");
    expect((await call("/search/stories?q=jaipur", viewer)).status).toBe(200);
    expect((await call("/search/stories?q=jaipur", { cookie: "", csrf: "" })).status).toBe(401);
  });

  it("400 for a bad query", async () => {
    for (const url of ["/search/stories", "/search/stories?q=", `/search/stories?q=${"x".repeat(101)}`, "/search/stories?q=jaipur&limit=0", "/search/stories?q=jaipur&limit=51", "/search/stories?q=jaipur&page=2"]) {
      const r = await call(url);
      expect(r.status, url).toBe(400);
      expect(r.body.error).toBe("invalid");
    }
  });

  it(`at most ${STORY_SEARCHES_PER_MINUTE} searches a minute per user`, async () => {
    const limited = { cookie: "", csrf: "" };
    await signIn(app, limited, "busy@test");
    for (let i = 0; i < STORY_SEARCHES_PER_MINUTE; i++) expect((await call("/search/stories?q=jaipur", limited)).status).toBe(200);
    const over = await call("/search/stories?q=jaipur", limited);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("rate_limited");
    // Another user is not held up
    expect((await call("/search/stories?q=jaipur", { cookie: "", csrf: "" }, app)).status).toBe(401);
    expect((await call("/search/stories?q=jaipur", otherSession)).status).toBe(200);
  });
});
