// POST /handles/desk: a handle typed on a post's tag line joins the directory at once, with the keywords found
// inside it, and the draft then accepts it as a mention. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog, createDb, handleDirectory, hashtagStaging, loadRuleComposer, orgs, postDrafts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { DESK_HANDLE_ADDS } from "../src/routes/library";

const URL_ = process.env.TEST_DATABASE_URL;

(URL_ ? describe : describe.skip)("desk-added handles", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  let draftId = "";
  const op = { cookie: "", csrf: "" };
  const op2 = { cookie: "", csrf: "" };
  const viewer = { cookie: "", csrf: "" };

  const config: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 5).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };

  async function call(s: typeof op, method: string, url: string, payload?: unknown) {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: s.cookie, "x-csrf": s.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function signIn(s: typeof op, email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    s.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    s.csrf = JSON.parse(res.body).csrfToken;
  }

  const rows = (handle: string) =>
    h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), sql`lower(${handleDirectory.handle}) = ${handle.toLowerCase()}`));

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const pw = await hashPassword("correct horse battery");
    await h.db.insert(users).values([
      { orgId, name: "Op", email: "op@test", passwordHash: pw, role: "operator" },
      { orgId, name: "Op Two", email: "op2@test", passwordHash: pw, role: "operator" },
      { orgId, name: "Viewer", email: "viewer@test", passwordHash: pw, role: "viewer" },
    ]);
    // A handle the editors added earlier, stored with its @ and in another case
    await h.db.insert(handleDirectory).values({ orgId, entityName: "Kota", aliases: ["Kota"], handle: "@KotaUpdates", source: "manual", verifiedAt: new Date() });
    // In the directory but not verified yet (e.g. added by hand with no verification)
    await h.db.insert(handleDirectory).values({ orgId, entityName: "Pending", aliases: [], handle: "PendingHandle", source: "manual", verifiedAt: null });
    const [story] = await h.db.insert(stories).values({ orgId, slug: "jhalawar-rain", status: "composed", headline: "झालावाड़ में बारिश", body: "", layout: "breaking", mediaState: "none" }).returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: story!.id, status: "ready", bodyText: "#Jhalawar: झालावाड़ में बारिश", cardHeadline: "झालावाड़ में बारिश", hashtags: ["#RajasthanWithFirstIndia"], composeVersion: "b2", cardRev: 0 })
      .returning();
    draftId = draft!.id;

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-deskh-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config }, false);
    await signIn(op, "op@test");
    await signIn(op2, "op2@test");
    await signIn(viewer, "viewer@test");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("adds a new handle at once, with its place's English and Hindi names as keywords", async () => {
    const res = await call(op, "POST", "/handles/desk", { handle: "@JhalawarUpdates" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ handle: "@JhalawarUpdates", entityName: "Jhalawar", source: "desk", verified: true, created: true, keywordsWithheld: null });
    expect(res.body.keywords).toEqual(["Jhalawar", "झालावाड़", "झालावाड"]);
    const [row] = await rows("JhalawarUpdates");
    expect(row).toMatchObject({ handle: "JhalawarUpdates", entityName: "Jhalawar", entityNameHi: "झालावाड़", source: "desk", platform: "x" });
    expect(row!.verifiedAt).not.toBeNull();
    expect(row!.verifiedBy).not.toBeNull();
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, row!.id), eq(auditLog.action, "handle.desk_add")));
    expect(audits).toHaveLength(1);
  });

  it("gives a subject's handle its name (not also the district in it), and adds a handle with none as it is", async () => {
    const rpsc = await call(op, "POST", "/handles/desk", { handle: "RPSC_Ajmer" });
    expect(rpsc.status).toBe(201);
    expect(rpsc.body.keywords).toEqual(["RPSC", "आरपीएससी", "राजस्थान लोक सेवा आयोग"]);
    const none = await call(op, "POST", "/handles/desk", { handle: "@RandomGuy123" });
    expect(none.status).toBe(201);
    expect(none.body).toMatchObject({ handle: "@RandomGuy123", entityName: "RandomGuy123", keywords: [], created: true });
    expect((await rows("RandomGuy123"))[0]!.entityNameHi).toBeNull();
  });

  it("adds party, official and file handles (mention-able at once) but gives them no keywords, so they are never suggested", async () => {
    const cases: [string, string][] = [
      ["@BJP4Jhalawar", "party"], ["@KotaCongress", "party"],
      ["@CollectorTonkX", "official"],
      ["@JhalawarPolice", "file_handle"], ["@DMSalumbar", "file_handle"], ["@AcbRajasthan", "file_handle"], ["@iitjodhpur", "file_handle"], ["@RuhsJaipur", "file_handle"],
      // @INCJaipur is a party handle AND two letters from @IMDJaipur in subject-handles.json; the
      // lookalike guard catches it first. Either way it gets no keywords and is never suggested.
      ["@INCJaipur", "lookalike"], ["@JhalawarPolic", "lookalike"], ["@SPJhalawar", "lookalike"],
    ];
    for (const [handle, why] of cases) {
      const res = await call(op, "POST", "/handles/desk", { handle });
      expect(res.status, handle).toBe(201);
      expect(res.body, handle).toMatchObject({ keywords: [], keywordsWithheld: why, entityName: handle.slice(1), created: true });
      const [row] = await rows(handle.slice(1));
      expect(row!.aliases, handle).toEqual([]);
      expect(row!.verifiedAt, handle).not.toBeNull();
    }
  });

  it("gives a typo near-copy of a handle already in the directory no keywords, so the two are never both suggested", async () => {
    const typo = await call(op, "POST", "/handles/desk", { handle: "@JhalawarUpdatse" }); // a swap from @JhalawarUpdates
    expect(typo.status).toBe(201);
    expect(typo.body).toMatchObject({ keywords: [], keywordsWithheld: "lookalike", entityName: "JhalawarUpdatse", created: true });
    expect((await rows("JhalawarUpdatse"))[0]!.aliases).toEqual([]);
    const nearManual = await call(op, "POST", "/handles/desk", { handle: "@KotaUpdatez" }); // one letter from the manual @KotaUpdates
    expect(nearManual.body).toMatchObject({ keywords: [], keywordsWithheld: "lookalike" });
    // A different local handle for the same place still gets its keywords
    const other = await call(op, "POST", "/handles/desk", { handle: "@JhalawarDaily" });
    expect(other.body).toMatchObject({ keywords: ["Jhalawar", "झालावाड़", "झालावाड"], keywordsWithheld: null });
  });

  it("refuses a handle the org has but has not verified, with a clear error", async () => {
    const res = await call(op, "POST", "/handles/desk", { handle: "@pendinghandle" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("handle_unverified");
    expect(await rows("PendingHandle")).toHaveLength(1);
  });

  it("returns a handle the org already has, whatever its case or @, and never adds it twice", async () => {
    const again = await call(op2, "POST", "/handles/desk", { handle: "jhalawarupdates" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ handle: "@JhalawarUpdates", created: false, keywords: ["Jhalawar", "झालावाड़", "झालावाड"] });
    const manual = await call(op, "POST", "/handles/desk", { handle: "@kotaupdates" });
    expect(manual.status).toBe(200);
    expect(manual.body).toMatchObject({ handle: "@KotaUpdates", source: "manual", created: false });
    // Two people typing the same new handle at once get one row
    const [a, b] = await Promise.all([call(op, "POST", "/handles/desk", { handle: "@BundiNews" }), call(op2, "POST", "/handles/desk", { handle: "@bundinews" })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await rows("BundiNews")).toHaveLength(1);
    expect(await rows("JhalawarUpdates")).toHaveLength(1);
  });

  it("checks the handle and who may add one", async () => {
    expect((await call(op, "POST", "/handles/desk", { handle: "@has space" })).status).toBe(400);
    expect((await call(op, "POST", "/handles/desk", { handle: "@SixteenLettersXX" })).status).toBe(400);
    expect((await call(op, "POST", "/handles/desk", { handle: "" })).status).toBe(400);
    expect((await call(op, "POST", "/handles/desk", { handle: "@ok", orgId: "x" })).status).toBe(400);
    const denied = await call(viewer, "POST", "/handles/desk", { handle: "@ViewerTried" });
    expect(denied.status).toBe(403);
    expect(await rows("ViewerTried")).toHaveLength(0);
  });

  it("lets the draft take the handle as a mention, in any case; an unknown one is still refused", async () => {
    const claimed = await call(op, "POST", `/drafts/${draftId}/claim`);
    expect(claimed.status).toBe(200);
    const bad = await call(op, "PATCH", `/drafts/${draftId}`, { version: claimed.body.version, mentions: ["@NobodyAddedThis"] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("bad_mention");
    const ok = await call(op, "PATCH", `/drafts/${draftId}`, { version: claimed.body.version, mentions: ["@JHALAWARUPDATES", "@RandomGuy123", "@BJP4Jhalawar"] });
    expect(ok.status).toBe(200);
    expect(ok.body.mentions).toEqual(["@JHALAWARUPDATES", "@RandomGuy123", "@BJP4Jhalawar"]); // no keywords, still taggable by hand
  });

  // ─── The loop that keeps the reporter list from decaying ──────────────────
  // A breaking file names its reporter ("...NDR_PK_AGARWAL_BIG"). When the list does not know that name
  // the post goes out with no byline and the name is recorded on the draft. An editor adding the
  // reporter's handle by hand is the desk telling us whose name that is, so it is stored against the
  // handle and the worker resolves the same file name by itself from then on.
  it("learns the file's reporter name from the handle an editor adds, and only from a reporter's handle", async () => {
    const [story] = await h.db
      .insert(stories)
      .values({ orgId, slug: "reporter-learn", status: "composed", headline: "बाजार में रौनक", body: "", layout: "breaking", mediaState: "none" })
      .returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: story!.id, status: "ready", bodyText: "बाजार में रौनक", cardHeadline: "बाजार में रौनक",
        hashtags: ["#RajasthanWithFirstIndia"], composeVersion: "b4", cardRev: 0,
        // What the composer left behind: the name it could not place
        handlePick: { cls: "other", why: "no class matched", warnings: ["the file name's reporter \"PK_AGARWAL\" is not in the reporter list, so no byline was added"], handles: [], reporterToken: "PK AGARWAL" },
      })
      .returning();
    const id = draft!.id;
    const claimed = await call(op, "POST", `/drafts/${id}/claim`);
    expect(claimed.status).toBe(200);

    // A reporter's handle is one an editor may add even though it is in no directory row yet
    const saved = await call(op, "PATCH", `/drafts/${id}`, { version: claimed.body.version, mentions: ["@omsharma8888"] });
    expect(saved.status).toBe(200);
    expect(saved.body.mentions).toEqual(["@omsharma8888"]);
    const [learned] = await h.db
      .select()
      .from(handleDirectory)
      .where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "reporter"), sql`lower(${handleDirectory.handle}) = '@omsharma8888'`));
    expect(learned!.aliases).toEqual(["PK_AGARWAL"]);
    expect(learned!.verifiedAt).not.toBeNull();
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "handle.reporter_token_learned"))).length).toBe(1);

    // Saving again does not store the same name twice
    const again = await call(op, "PATCH", `/drafts/${id}`, { version: saved.body.version, mentions: ["@omsharma8888", "@JhalawarUpdates"] });
    expect(again.status).toBe(200);
    const [still] = await h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "reporter")));
    expect(still!.aliases).toEqual(["PK_AGARWAL"]);
    // ...and a handle that is not a reporter's teaches us nothing: it says nothing about whose byline
    // the file carries, and learning from it would put it on every later story by the same reporter
    expect(await h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "reporter")))).toHaveLength(1);
  });

  it("adds the name to a reporter row an admin un-verified, without putting the handle back in use", async () => {
    // verified_at is what lets a handle be suggested, so un-verifying one takes it out of use. Teaching
    // the row another file name must not quietly undo that decision.
    await h.db
      .update(handleDirectory)
      .set({ verifiedAt: null })
      .where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "reporter")));
    const [story] = await h.db
      .insert(stories)
      .values({ orgId, slug: "unverified-reporter", status: "composed", headline: "बाजार में रौनक", body: "", layout: "breaking", mediaState: "none" })
      .returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: story!.id, status: "ready", bodyText: "बाजार में रौनक", cardHeadline: "बाजार में रौनक",
        hashtags: ["#RajasthanWithFirstIndia"], composeVersion: "b4", cardRev: 0,
        handlePick: { cls: "other", why: "no class matched", warnings: [], handles: [], reporterToken: "RAJEEV" },
      })
      .returning();
    const claimed = await call(op, "POST", `/drafts/${draft!.id}/claim`);
    expect((await call(op, "PATCH", `/drafts/${draft!.id}`, { version: claimed.body.version, mentions: ["@omsharma8888"] })).status).toBe(200);
    const [row] = await h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "reporter")));
    expect(row!.aliases).toEqual(["PK_AGARWAL", "RAJEEV"]); // the name was still recorded
    expect(row!.verifiedAt).toBeNull(); // ...and the handle stays out of use
    await h.db.update(handleDirectory).set({ verifiedAt: new Date() }).where(eq(handleDirectory.id, row!.id));
  });

  it("learns nothing when the file's reporter already has a handle, and refuses an unverified one", async () => {
    const [story] = await h.db
      .insert(stories)
      .values({ orgId, slug: "already-bylined", status: "composed", headline: "बाजार में रौनक", body: "", layout: "breaking", mediaState: "none" })
      .returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: story!.id, status: "ready", bodyText: "बाजार में रौनक", cardHeadline: "बाजार में रौनक",
        hashtags: ["#RajasthanWithFirstIndia"], mentions: ["@rituraj9999"], composeVersion: "b4", cardRev: 0,
        // The name already resolved: this post has its byline
        handlePick: { cls: "other", why: "no class matched", warnings: [], handles: [{ handle: "@rituraj9999", reason: "reporter" }], reporterToken: "RITURAJ" },
      })
      .returning();
    const claimed = await call(op, "POST", `/drafts/${draft!.id}/claim`);
    // A second reporter's handle on the same post (a co-byline) must NOT teach us that RITURAJ means
    // them: a name two reporters claim is then tagged for neither, on every later story carrying it
    const saved = await call(op, "PATCH", `/drafts/${draft!.id}`, { version: claimed.body.version, mentions: ["@rituraj9999", "@aishwaryam99"] });
    expect(saved.status).toBe(200);
    const taught = await h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "reporter")));
    expect(taught.map((r) => r.handle)).not.toContain("@aishwaryam99");

    // A reporter the desk has left unverified is not a handle an editor may put on a post this way:
    // the reporter list only waives the directory check for entries the desk has decided about
    const bad = await call(op, "PATCH", `/drafts/${draft!.id}`, { version: saved.body.version, mentions: ["@satyatv99_news"] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("bad_mention");
  });

  // ─── The same loop for hashtags ───────────────────────────────────────────
  // A breaking post carries the footer tag and nothing else automatically, so every other hashtag on it
  // was typed by an editor — the most direct evidence there is of a rule we are missing.
  // Staged when the post goes out, never on a save: the editor autosaves while the desk is still typing.
  const PICK = { cls: "political", why: "a party or politician", warnings: [], handles: [] };
  const makeTagDraft = async (slug: string, opts: { suggestions?: string[]; pick?: boolean } = {}) => {
    const [story] = await h.db
      .insert(stories)
      .values({ orgId, slug, status: "composed", headline: "पंचायत चुनाव का परिणाम", body: "", layout: "breaking", mediaState: "none" })
      .returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: story!.id, status: "ready", bodyText: "पंचायत चुनाव का परिणाम", cardHeadline: "पंचायत चुनाव का परिणाम",
        hashtags: ["#RajasthanWithFirstIndia"], hashtagSuggestions: opts.suggestions ?? ["#RajasthanElection"], composeVersion: "b5", cardRev: 0,
        handlePick: opts.pick === false ? null : PICK,
      } as typeof postDrafts.$inferInsert)
      .returning();
    return draft!.id;
  };
  /** Claim, save the tags, then Copy & posted; returns the save's response */
  const tagAndPost = async (id: string, hashtags: string[], post = true) => {
    const claimed = await call(op, "POST", `/drafts/${id}/claim`);
    const saved = await call(op, "PATCH", `/drafts/${id}`, { version: claimed.body.version, hashtags });
    expect(saved.status).toBe(200);
    if (post) expect((await call(op, "POST", `/drafts/${id}/copy-posted`, { version: saved.body.version })).status).toBe(200);
    return saved;
  };
  const staged = () => h.db.select().from(hashtagStaging).where(eq(hashtagStaging.orgId, orgId));
  const stagedTag = async (key: string) => (await staged()).find((r) => r.tagKey === key);

  it("stages a hashtag the editor posted that no rule of ours produced, counting repeats", async () => {
    // One tag we already have, one we offered, and one the desk reached for that we know nothing about
    await tagAndPost(await makeTagDraft("hashtag-learn-1"), ["#RajasthanWithFirstIndia", "#RajasthanElection", "#RajasthanPanchayatElection2026"]);
    let rows = await staged();
    expect(rows.map((r) => r.tag)).toEqual(["#RajasthanPanchayatElection2026"]);
    expect(rows[0]!.uses).toBe(1);
    expect(rows[0]!.tagKey).toBe("rajasthanpanchayatelection2026");
    expect((rows[0]!.examples as { headline: string }[])[0]!.headline).toBe("पंचायत चुनाव का परिणाम");

    // The same tag on another post counts up rather than making a second row, whatever the casing
    await tagAndPost(await makeTagDraft("hashtag-learn-2"), ["#rajasthanPanchayatElection2026"]);
    rows = await staged();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uses).toBe(2);
    expect((rows[0]!.examples as unknown[]).length).toBe(2);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "hashtag.staged"))).length).toBe(2);
  });

  it("stages nothing on a save: an autosave mid-typing carries half a tag", async () => {
    await tagAndPost(await makeTagDraft("hashtag-autosave"), ["#RajasthanWithFirstIndia", "#Rajas"], false);
    expect(await stagedTag("rajas")).toBeUndefined();
  });

  it("stages nothing for a tag we applied or offered ourselves", async () => {
    const before = (await staged()).length;
    // Accepting our own suggestion is the rule working, not a gap
    await tagAndPost(await makeTagDraft("hashtag-noop", { suggestions: ["#RoadAccident"] }), ["#RajasthanWithFirstIndia", "#RoadAccident"]);
    expect((await staged()).length).toBe(before);
  });

  it("stages nothing from a draft the old composer tagged, or a non-breaking one", async () => {
    // No handle_pick: composed before footer-only, when the composer applied topic tags itself
    await tagAndPost(await makeTagDraft("hashtag-old", { pick: false }), ["#RajasthanWithFirstIndia", "#OldRuleTag"]);
    expect(await stagedTag("oldruletag")).toBeUndefined();
  });

  it("counts a draft once when it is posted, undone and posted again", async () => {
    const id = await makeTagDraft("hashtag-repost");
    await tagAndPost(id, ["#RajasthanWithFirstIndia", "#RepostOnce"]);
    expect((await call(op, "POST", `/drafts/${id}/copy-posted/undo`)).status).toBe(200);
    await tagAndPost(id, ["#RajasthanWithFirstIndia", "#RepostOnce"]);
    expect((await stagedTag("repostonce"))!.uses).toBe(1);
  });

  it("learns nothing from a draft whose file named no reporter", async () => {
    const [story] = await h.db
      .insert(stories)
      .values({ orgId, slug: "no-reporter", status: "composed", headline: "बाजार में रौनक", body: "", layout: "breaking", mediaState: "none" })
      .returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: story!.id, status: "ready", bodyText: "बाजार में रौनक", cardHeadline: "बाजार में रौनक",
        hashtags: ["#RajasthanWithFirstIndia"], composeVersion: "b4", cardRev: 0,
        handlePick: { cls: "other", why: "no class matched", warnings: [], handles: [], reporterToken: null },
      })
      .returning();
    const claimed = await call(op, "POST", `/drafts/${draft!.id}/claim`);
    const saved = await call(op, "PATCH", `/drafts/${draft!.id}`, { version: claimed.body.version, mentions: ["@aishwaryam99"] });
    expect(saved.status).toBe(200);
    const reporterRows = await h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "reporter")));
    expect(reporterRows.map((r) => r.handle)).toEqual(["@omsharma8888"]); // only the one learned above
  });

  it("limits how many new handles one person adds in a while; known ones stay free", async () => {
    const made: number[] = [];
    // op2 has added none of its own so far (its two calls above found existing rows or lost the race)
    const own = await h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.source, "desk")));
    const op2Id = (await h.db.select().from(users).where(eq(users.email, "op2@test")))[0]!.id;
    const already = own.filter((r) => r.verifiedBy === op2Id).length;
    // A refused add costs nothing
    for (let i = 0; i < 3; i++) expect((await call(op2, "POST", "/handles/desk", { handle: "@PendingHandle" })).status).toBe(409);
    for (let i = already; i < DESK_HANDLE_ADDS; i++) made.push((await call(op2, "POST", "/handles/desk", { handle: `@Limit${i}` })).status);
    expect(made.every((s) => s === 201)).toBe(true);
    const over = await call(op2, "POST", "/handles/desk", { handle: "@OneTooMany" });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("rate_limited");
    expect(await rows("OneTooMany")).toHaveLength(0);
    expect((await call(op2, "POST", "/handles/desk", { handle: "@JhalawarUpdates" })).status).toBe(200);
    expect((await call(op, "POST", "/handles/desk", { handle: "@SomeoneElseOk" })).status).toBe(201); // per person
  });

  it("keeps desk-added handles out of the phase-2 / Web Scraper composer: only phase 1 suggests them, under its rules", async () => {
    const { composer } = await loadRuleComposer(h.db, orgId);
    const out = await composer.compose({ headline: "Heavy rain in Jhalawar and Kota", body: "RandomGuy123 and Jhalawar again", place: null });
    const suggested = out.mentionSuggestions.map((m) => m.handle);
    expect(suggested).toContain("@KotaUpdates"); // a manual directory row still is
    expect(suggested).not.toContain("@JhalawarUpdates");
    expect(suggested).not.toContain("@RandomGuy123");
  });
});
