// Watched keywords searched on every Web Scraper run: Google News (the live search's source), a few
// keywords a run in turn (each org its own place), one failing keyword never stopping the rest, a pause
// for everyone on "too many requests" or a source that stops answering, a time budget per run.
// Recorded feeds (google-news-hi.xml, 28 Oct 2026) and a trimmed search answer in the same format. No network.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEYWORD_SEARCH_GAP_MS, KEYWORD_SEARCH_PER_RUN, plainError, googleNewsSearchUrl, keywordEdition, keywordQueue, memoryPaceStore, runTrendSources, searchWatchedKeywords,
  trendTagger, watchHits, type PaceStore, type SourcePlan, type TextGet,
} from "../src";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/trends", name), "utf8");
const NOW = new Date("2026-10-28T18:00:00Z");
const tagger = trendTagger([{ id: "d1", matchType: "district", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 5 }]);

function clockGate() {
  let t = NOW.getTime();
  const slept: number[] = [];
  const gate = memoryPaceStore(() => t, async (ms: number) => {
    slept.push(ms);
    t += ms;
  });
  return { gate, slept, tick: (ms: number) => void (t += ms), now: () => t };
}

/** Serves the given URLs; anything else answers 404 (or the given error) */
function web(served: Record<string, string>, otherwise = "HTTP 404") {
  const asked: string[] = [];
  const get: TextGet = async (url) => {
    asked.push(url);
    const body = served[url];
    if (body === undefined) throw new Error(otherwise);
    return body;
  };
  return { get, asked };
}

describe("the keyword list", () => {
  it("searches each keyword once (folded alike), in a stable order, in its script's edition", () => {
    expect(keywordQueue(["Metro", " metro ", "मेट्रो", "", "!!", "Jaipur  Metro"])).toEqual(["Jaipur Metro", "Metro", "मेट्रो"]);
    expect(keywordEdition("मेट्रो")).toBe("hi");
    expect(keywordEdition("Jaipur Metro")).toBe("en");
    expect(keywordEdition("फेज-2")).toBe("hi");
  });
});

describe("searching the watched keywords in a run", () => {
  const plan: SourcePlan = { googleNews: { hi: "राजस्थान", en: "" }, feeds: [], geo: "", gdelt: false };

  it("merges the found stories as normal items, deduped with the feeds, kept only when they name the keyword", async () => {
    const c = clockGate();
    const w = web({
      [googleNewsSearchUrl("राजस्थान", "hi")]: fixture("google-news-hi.xml"),
      [googleNewsSearchUrl("मेट्रो", "hi")]: fixture("google-news-search-metro-hi.xml"),
      // The same answer as the main feed: every item is already there
      [googleNewsSearchUrl("पंचायत", "hi")]: fixture("google-news-hi.xml"),
    });
    const run = await runTrendSources(w.get, plan, tagger, NOW, c.gate, [], ["मेट्रो", "पंचायत", "Nowhere"]);

    expect(w.asked).toEqual([
      googleNewsSearchUrl("राजस्थान", "hi"),
      googleNewsSearchUrl("Nowhere", "en"), googleNewsSearchUrl("पंचायत", "hi"), googleNewsSearchUrl("मेट्रो", "hi"),
    ]);
    // A second apart, through the pace store
    expect(c.slept).toEqual([KEYWORD_SEARCH_GAP_MS, KEYWORD_SEARCH_GAP_MS]);
    // One keyword failing is reported, the others still count, and the run goes on
    expect(run.keywordSearch.failed).toEqual([{ keyword: "Nowhere", error: "The source answered with an error (HTTP 404)." }]);
    const ks = run.health.find((h) => h.name === "Keyword search")!;
    // Mostly working: ok, with a note on what failed
    expect(ks).toMatchObject({
      group: "News", ok: true, at: NOW.toISOString(), lastSuccessAt: NOW.toISOString(), lastError: "1 of 3 keywords failed: The source answered with an error (HTTP 404).",
    });
    expect(run.health.map((h) => [h.name, h.ok])).toEqual([["Google News (hi)", true], ["Keyword search", true]]);

    const articles = run.rows.filter((r) => r.type === "articles" && r.window === "24h");
    // Found only by the search, and it names the keyword: a normal item the desk's watch hits show on
    const metro = articles.filter((r) => r.url.includes("KW-METRO"));
    expect(metro.map((r) => r.url).sort()).toEqual(["https://news.google.com/rss/articles/KW-METRO-1?oc=5", "https://news.google.com/rss/articles/KW-METRO-2?oc=5"]);
    expect(metro.every((r) => watchHits(["मेट्रो"], r.title).length === 1)).toBe(true);
    expect(metro.find((r) => r.url.endsWith("KW-METRO-1?oc=5"))).toMatchObject({ platform: "Google News", sourceName: "Dainik Bhaskar", district: "Jaipur" });
    // The search result whose headline does not name the keyword is left out
    expect(articles.some((r) => r.url.includes("KW-METRO-3"))).toBe(false);
    // Found by the feed and the search: one row per article
    const urls = articles.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
    // The source line counts what the searches brought (before grouping): both "मेट्रो" stories and the "पंचायत" ones
    expect(run.keywordSearch.articles.filter((a) => a.url.includes("KW-METRO"))).toHaveLength(2);
    expect(run.keywordSearch.articles.length).toBeGreaterThan(2);
    expect(ks.items).toBe(run.keywordSearch.articles.length);
  });

  it("takes turns: at most KEYWORD_SEARCH_PER_RUN a run, the next run starts where this one stopped, each org its own place", async () => {
    const c = clockGate();
    const keywords = Array.from({ length: KEYWORD_SEARCH_PER_RUN + 2 }, (_, i) => `kw${String(i).padStart(2, "0")}`);
    const w = web({});
    const first = await searchWatchedKeywords(w.get, keywords, c.gate, NOW, [], { scope: "org-a" });
    expect(first.searched).toEqual(keywords.slice(0, KEYWORD_SEARCH_PER_RUN));
    expect(w.asked).toHaveLength(KEYWORD_SEARCH_PER_RUN);
    // Every one 404s: the source is down for this run, in plain words
    expect(first.health).toMatchObject({ name: "Keyword search", ok: false, items: 0, lastError: "The source answered with an error (HTTP 404)." });
    // A 404 is the keyword's own problem: its turn is used, and nobody is paused
    expect(c.gate.states.get("keywords")).toMatchObject({ backoffUntil: 0, failures: 0 });
    expect(c.gate.states.get("keywords.cursor.org-a")).toMatchObject({ cache: { next: KEYWORD_SEARCH_PER_RUN } });

    // Another org starts at its own beginning
    const other = await searchWatchedKeywords(w.get, keywords, c.gate, NOW, [], { scope: "org-b" });
    expect(other.searched[0]).toBe("kw00");

    const second = await searchWatchedKeywords(w.get, keywords, c.gate, NOW, [], { scope: "org-a" });
    expect(second.searched).toEqual([...keywords.slice(KEYWORD_SEARCH_PER_RUN), ...keywords.slice(0, KEYWORD_SEARCH_PER_RUN - 2)]);
    // A shorter list later: the place wraps round
    const third = await searchWatchedKeywords(w.get, keywords.slice(0, 3), c.gate, NOW, [], { scope: "org-a" });
    expect(third.searched).toHaveLength(3);
    // Nobody watches anything: no request, no source line
    expect(await searchWatchedKeywords(w.get, [], c.gate, NOW)).toEqual({ articles: [], health: null, searched: [], failed: [] });
  });

  it("stops at the time budget; the keywords not reached keep their turn", async () => {
    const c = clockGate();
    const keywords = Array.from({ length: KEYWORD_SEARCH_PER_RUN }, (_, i) => `kw${i}`);
    const r = await searchWatchedKeywords(web({}).get, keywords, c.gate, NOW, [], { budgetMs: 3 * KEYWORD_SEARCH_GAP_MS });
    expect(r.searched).toEqual(["kw0", "kw1", "kw2", "kw3"]);
    expect(c.gate.states.get("keywords.cursor.default")).toMatchObject({ cache: { next: 4 } });
  });

  it("stops and pauses everyone on too many requests; the refused keyword keeps its turn; nothing is asked while paused", async () => {
    const c = clockGate();
    const refuse = ["HTTP 429 (rate limited)", "HTTP 429 (rate limited)"];
    const asked: string[] = [];
    const get: TextGet = async (url) => {
      asked.push(url);
      const no = refuse.shift();
      if (no) throw new Error(no);
      return url === googleNewsSearchUrl("मेट्रो", "hi") ? fixture("google-news-search-metro-hi.xml") : "<rss><channel></channel></rss>";
    };
    const keywords = ["alpha", "beta", "मेट्रो"];
    const r = await searchWatchedKeywords(get, keywords, c.gate, NOW, [], { scope: "org-a" });
    expect(r.searched).toEqual(["alpha"]);
    expect(r.health).toMatchObject({ ok: false, lastError: "Paused: Google News asked us to slow down. Next try in about 10 min." });
    expect(c.gate.states.get("keywords")).toMatchObject({ failures: 1, backoffUntil: c.now() + 10 * 60_000 });
    expect(c.gate.states.get("keywords.cursor.org-a")).toMatchObject({ cache: { next: 0 } });

    // The pause is for every org (one IP)
    c.tick(5 * 60_000);
    const paused = await searchWatchedKeywords(get, keywords, c.gate, NOW, [], { scope: "org-b" });
    expect(paused.health).toMatchObject({ ok: false, lastError: "Paused: Google News asked us to slow down. Next try in about 5 min." });
    expect(asked).toHaveLength(1);

    // After the pause: "alpha" again first; refused again, the pause doubles
    c.tick(6 * 60_000);
    const again = await searchWatchedKeywords(get, keywords, c.gate, NOW, [], { scope: "org-a" });
    expect(again.searched).toEqual(["alpha"]);
    expect(c.gate.states.get("keywords")).toMatchObject({ failures: 2, backoffUntil: c.now() + 20 * 60_000 });

    // Answered after a refusal: the pause count resets, the found stories come back
    c.tick(21 * 60_000);
    const ok = await searchWatchedKeywords(get, keywords, c.gate, NOW, [], { scope: "org-a" });
    expect(ok.searched).toEqual(["alpha", "beta", "मेट्रो"]);
    expect(ok.health).toMatchObject({ ok: true, items: 2 });
    expect(ok.health!.lastError).toBeUndefined();
    expect(c.gate.states.get("keywords")).toMatchObject({ failures: 0, backoffUntil: 0 });
  });

  it("stops after two dropped answers in a row (time-outs, 5xx), but not after one", async () => {
    const c = clockGate();
    const script: (string | null)[] = ["Timed out after 20 s", null, "HTTP 503", "fetch failed (ECONNRESET)", null];
    const get: TextGet = async () => {
      const no = script.shift();
      if (no) throw new Error(no);
      return "<rss><channel></channel></rss>";
    };
    const keywords = ["k1", "k2", "k3", "k4", "k5"];
    const r = await searchWatchedKeywords(get, keywords, c.gate, NOW);
    // k1 timed out alone (k2 answered); k3 and k4 dropped in a row: stop before k5
    expect(r.searched).toEqual(["k1", "k2", "k3", "k4"]);
    expect(r.failed.map((f) => f.keyword)).toEqual(["k1", "k3", "k4"]);
    expect(r.health).toMatchObject({ ok: false, lastError: "Paused: Google News stopped answering. Next try in about 10 min. 1 of 4 keywords answered first." });
    // k3 and k4 keep their turn
    expect(c.gate.states.get("keywords.cursor.default")).toMatchObject({ cache: { next: 2 } });
    expect(c.gate.states.get("keywords")).toMatchObject({ failures: 1 });
  });

  it("never fails the run: the pace store's database failing gives a down line, the other sources stay", async () => {
    const mem = memoryPaceStore(() => NOW.getTime(), async () => undefined);
    const broken: PaceStore = { ...mem, load: async (key) => (key.startsWith("keywords") ? Promise.reject(new Error("connection terminated unexpectedly")) : mem.load(key)) };
    const w = web({ [googleNewsSearchUrl("राजस्थान", "hi")]: fixture("google-news-hi.xml") });
    const run = await runTrendSources(w.get, plan, tagger, NOW, broken, [], ["मेट्रो"], { scope: "org-a" });
    expect(run.health.map((h) => [h.name, h.ok])).toEqual([["Google News (hi)", true], ["Keyword search", false]]);
    expect(run.health[1]!.lastError).toBe(plainError(new Error("connection terminated unexpectedly")));
    expect(run.rows.length).toBeGreaterThan(0);
  });
});
