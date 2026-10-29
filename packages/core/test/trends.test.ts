// The Web Scraper's rules, on feeds recorded on 28 Oct 2026 (trimmed). No network here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEEDS, GENERAL_TAG, TREND_TOP, buildTrends, collectSources, compact, gdeltQuery, gdeltTimelineUrl, gdeltVolume, googleNewsSearchUrl,
  googleTrendsUrl, groupArticles, metaImage, parseFeedList, parseGdeltTimeline, parseGoogleTrends, parseRss, runTrendSources, searchTrendSources,
  topicHashtag, trafficCount, trendTagger, bingNewsUrl, GDELT_MIN_GAP_MS, GDELT_TOPICS_PER_RUN, addGdeltVolume, gdeltTimeline, memoryPaceStore, plainError,
  type RawArticle, type SourceHealth, type SourcePlan, type TextGet, type TrendRow,
} from "../src";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/trends", name), "utf8");
const NOW = new Date("2026-10-28T18:00:00Z");

const tagger = trendTagger([
  { id: "t1", matchType: "entity", name: "हाईकोर्ट", aliases: ["High Court"], hashtagLatin: "RajasthanHighCourt", hashtagDevanagari: null, priority: 8 },
  { id: "d1", matchType: "district", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 5 },
]);

const article = (title: string, extra: Partial<RawArticle> = {}): RawArticle => ({
  title, url: `https://example.in/${encodeURIComponent(title)}`, sourceName: "Example", platform: "RSS", publishedAt: new Date(NOW.getTime() - 3600_000),
  description: "", imageUrl: null, imageSource: null, rajasthanFeed: false, ...extra,
});

describe("parsing the feeds", () => {
  it("reads Google News: publisher from <source>, title without the ' - Publisher' suffix", () => {
    const items = parseRss(fixture("google-news-hi.xml"), { name: "Google News", platform: "Google News", rajasthan: true });
    expect(items).toHaveLength(10);
    const first = items[0]!;
    expect(first.sourceName).toBe("Navbharat Times");
    expect(first.title.endsWith("Navbharat Times")).toBe(false);
    expect(first.url).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\//);
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.platform).toBe("Google News");
    expect(items.every((i) => i.description === "")).toBe(true);
  });

  it("reads publisher feeds, with their pictures; GIFs are skipped", () => {
    const toi = parseRss(fixture("toi-jaipur.xml"), { name: "Times of India", platform: "RSS", rajasthan: true });
    expect(toi[0]).toMatchObject({ title: "Boost for Pali industrial township with rail link nod", sourceName: "Times of India", imageSource: "Times of India" });
    expect(toi[0]!.imageUrl).toMatch(/^https:\/\/static\.toiimg\.com\//);
    const bhaskar = parseRss(fixture("bhaskar-rajasthan.xml"), { name: "Dainik Bhaskar", platform: "RSS", rajasthan: true });
    expect(bhaskar.length).toBeGreaterThan(0);
    expect(bhaskar.every((b) => !b.imageUrl || !/\.gif/i.test(b.imageUrl))).toBe(true);
    expect(bhaskar[0]!.description.length).toBeGreaterThan(20);
  });

  it("takes the link from <guid> when <link> comes later or is missing (Amar Ujala)", () => {
    const items = parseRss(fixture("amarujala-rajasthan.xml"), { name: "Amar Ujala", platform: "RSS", rajasthan: true });
    expect(items[0]!.title.startsWith("बारां मंडी में मक्का की रिकॉर्ड आवक")).toBe(true);
    expect(items[0]!.url).toMatch(/^https:\/\/www\.amarujala\.com\/rajasthan\/baran\//);
  });

  it("decodes CDATA and entities, and drops items with no https link", () => {
    const xml = `<rss><channel><item><title><![CDATA[ A &amp; B ]]></title><link>https://x.in/a?b=1&amp;c=2</link></item>
      <item><title>No link</title><link>http://plain.in/x</link></item></channel></rss>`;
    expect(parseRss(xml, { name: "F", platform: "RSS", rajasthan: false })).toEqual([
      expect.objectContaining({ title: "A & B", url: "https://x.in/a?b=1&c=2" }),
    ]);
  });

  it("reads Google Trends: traffic, picture and the news behind each search", () => {
    const topics = parseGoogleTrends(fixture("google-trends-in.xml"));
    expect(topics).toHaveLength(5);
    expect(topics[0]).toMatchObject({ title: "investor", traffic: "200+", trafficCount: 200, imageSource: "NDTV" });
    expect(topics[0]!.news[0]).toMatchObject({ sourceName: "NDTV", platform: "Google Trends" });
    expect(topics[0]!.news[0]!.url).toMatch(/^https:\/\/www\.ndtv\.com\//);
    expect([trafficCount("2K+"), trafficCount("1M+"), trafficCount("1,000+"), trafficCount("lots")]).toEqual([2000, 1000000, 1000, null]);
  });

  it("reads GDELT's timeline and turns it into volume and growth", () => {
    const points = parseGdeltTimeline(JSON.parse(fixture("gdelt-timelinevolraw.json")));
    expect(points).toHaveLength(168);
    // last 6 h: 6 x 30; the 6 h before: 6 x 10
    expect(gdeltVolume(points, 12, NOW)).toEqual({ volume: "240 articles", growth: "+200% in 6h" });
    expect(gdeltVolume(points, 168, NOW).volume).toBe("1K articles");
    expect(gdeltVolume([], 24, NOW)).toEqual({ volume: "", growth: "" });
    expect(parseGdeltTimeline({ nope: 1 })).toEqual([]);
    expect([compact(950), compact(1234), compact(25_000), compact(2_500_000)]).toEqual(["950", "1.2K", "25K", "2.5M"]);
  });

  it("finds og:image (relative, entity-encoded) and falls back to twitter:image", () => {
    expect(metaImage(fixture("article-og.html"), "https://news.example.in/a/b.html")).toBe("https://news.example.in/images/lead.jpg?w=1200&h=630");
    expect(metaImage(`<meta name="twitter:image" content="https://c.in/p.png">`, "https://c.in/")).toBe("https://c.in/p.png");
    expect(metaImage(`<meta property="og:image" content="http://c.in/p.png">`, "https://c.in/")).toBeNull();
    expect(metaImage(`<meta property="og:image" content="https://c.in/p.gif">`, "https://c.in/")).toBeNull();
  });
});

describe("tagging", () => {
  it("finds the district named first, in either script, from the built-in list or the org's rules", () => {
    expect(tagger.district("बाड़मेर के बाटाडू और बांसवाड़ा में मतदान")).toBe("Barmer");
    expect(tagger.district("Boost for Pali industrial township")).toBe("Pali");
    expect(tagger.district("Sawai Madhopur tiger reserve")).toBe("Sawai Madhopur");
    expect(tagger.district("जयपुर में मेट्रो")).toBe("Jaipur");
    expect(tagger.district("Delhi news")).toBeNull();
  });

  it("gives a super tag from the fixed keyword map, or General", () => {
    expect(tagger.superTag("पंचायत चुनाव में मतदान")).toBe("Politics");
    expect(tagger.superTag("बेमौसम बारिश से फसल को नुकसान")).toBe("Weather");
    expect(tagger.superTag("Jaipur metro phase 2 approved")).toBe("Infrastructure");
    expect(tagger.superTag("कुछ और")).toBe(GENERAL_TAG);
  });

  it("scores Rajasthan relevance: a district counts more than the state's name", () => {
    expect(tagger.rajasthan("Rajasthan news")).toBe(1);
    expect(tagger.rajasthan("जयपुर में")).toBe(2);
    expect(tagger.rajasthan("राजस्थान: जयपुर में")).toBe(3);
    expect(tagger.rajasthan("Mumbai")).toBe(0);
  });

  it("gives the org's hashtags with their Devanagari variants", () => {
    expect(tagger.ruleTags("जयपुर हाईकोर्ट का फैसला")).toEqual(expect.arrayContaining([
      { latin: "#Jaipur", devanagari: "#जयपुर", district: "Jaipur" },
      { latin: "#RajasthanHighCourt", devanagari: null, district: null },
    ]));
    expect(topicHashtag("jaipur metro")).toBe("#JaipurMetro");
    expect(topicHashtag("राजस्थान चुनाव")).toBeNull();
    expect(topicHashtag("a b c d e")).toBeNull();
  });
});

describe("grouping and ranking", () => {
  it("drops the same URL twice and groups the same story told by different publishers", () => {
    const a = article("पंचायत चुनाव दूसरे चरण में बांसवाड़ा में सबसे ज्यादा मतदान", { sourceName: "A" });
    const b = article("बांसवाड़ा में पंचायत चुनाव का मतदान रिकॉर्ड, दूसरे चरण में भीड़", { sourceName: "B", url: "https://b.in/1" });
    const c = article("जयपुर मेट्रो फेज 2 को मंजूरी", { url: "https://c.in/1" });
    const groups = groupArticles([a, { ...a, url: `${a.url}?utm_source=x` }, b, c], { likeness: (x, y) => { let n = 0; for (const t of x) if (y.has(t)) n++; return n >= 3 ? 1 : 0; }, threshold: 0.5 });
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.articles.length === 2)!.publishers).toEqual(new Set(["A", "B"]));
  });

  it("ranks Rajasthan first, keeps the top 20 per type and window, and leaves out what is older than the window", () => {
    const articles: RawArticle[] = [
      article("Mumbai local trains delayed by rain", { url: "https://m.in/1" }),
      article("जयपुर में बारिश से जलभराव", { url: "https://j.in/1", rajasthanFeed: true }),
      article("Old Jaipur story from last week", { url: "https://j.in/old", publishedAt: new Date(NOW.getTime() - 3 * 86400_000) }),
      // 30 different stories: no word or trigram in common beyond "Rajasthan"
      ...Array.from({ length: 30 }, (_, i) => {
        const c = String.fromCodePoint(0x4e00 + i * 7);
        return article(`Rajasthan ${c.repeat(3)} ${c.repeat(4)} ${c.repeat(5)}`, { url: `https://r.in/${i}` });
      }),
    ];
    const rows = buildTrends({ articles, topics: [] }, tagger, NOW);
    const pool = rows.filter((r) => r.type === "articles" && r.window === "24h");
    // Every story of the window is kept (fewer than the pool size); the desk's list is the top 20 stories
    expect(pool).toHaveLength(32);
    const day = pool.filter((r) => r.clusterRank <= TREND_TOP);
    expect(day).toHaveLength(TREND_TOP);
    expect(day[0]!.title).toBe("जयपुर में बारिश से जलभराव");
    expect(day[0]).toMatchObject({ rank: 1, district: "Jaipur", superTag: "Weather" });
    expect(day.some((r) => r.title.startsWith("Mumbai"))).toBe(false);
    expect(day.some((r) => r.title.startsWith("Old Jaipur"))).toBe(false);
    expect(rows.filter((r) => r.type === "articles" && r.window === "7d").some((r) => r.title.startsWith("Old Jaipur"))).toBe(true);
    expect(day.map((r) => r.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("builds topics with real headlines as the reason, and hashtags from them", () => {
    const rows = buildTrends({
      articles: [
        article("जयपुर हाईकोर्ट ने भर्ती पर बड़ा फैसला सुनाया", { sourceName: "Bhaskar", url: "https://b.in/hc" }),
        article("हाईकोर्ट का भर्ती पर फैसला, जयपुर में सुनवाई पूरी", { sourceName: "Amar Ujala", url: "https://a.in/hc" }),
      ],
      topics: parseGoogleTrends(fixture("google-trends-in.xml")).map((t) => ({ ...t, publishedAt: NOW })),
    }, tagger, NOW);
    const topics = rows.filter((r) => r.type === "topics" && r.window === "24h");
    expect(topics[0]).toMatchObject({ district: "Jaipur", volume: "2 articles", shares: "2 publishers", superTag: "Politics" });
    // Named by one publisher's headline; the other publisher's headline is the reason
    const [named, other] = topics[0]!.title.startsWith("जयपुर हाईकोर्ट") ? ["(Bhaskar)", "(Amar Ujala)"] : ["(Amar Ujala)", "(Bhaskar)"];
    expect(topics[0]!.reasonWhy).toContain(other);
    expect(topics[0]!.reasonWhy).not.toContain(named);
    const trends = topics.filter((t) => t.platform === "Google Trends");
    expect(trends.length).toBe(5);
    expect(trends.find((t) => t.title === "investor")).toMatchObject({ volume: "200+ searches", sourceName: "Google Trends" });
    const tags = rows.filter((r) => r.type === "hashtags" && r.window === "24h");
    expect(tags.map((t) => t.title)).toEqual(expect.arrayContaining(["#Jaipur", "#RajasthanHighCourt", "#Investor"]));
    expect(tags.find((t) => t.title === "#Jaipur")).toMatchObject({ subTag: "#जयपुर", district: "Jaipur" });
  });
});

describe("collecting the sources", () => {
  const plan: SourcePlan = {
    googleNews: { hi: "राजस्थान", en: "Rajasthan" },
    feeds: [{ name: "Dainik Bhaskar", url: "https://feeds.example/bhaskar.xml", rajasthan: true }, { name: "Down", url: "https://feeds.example/down.xml", rajasthan: true }],
    geo: "IN",
    gdelt: true,
  };
  const served: Record<string, string> = {
    [googleNewsSearchUrl("राजस्थान", "hi")]: fixture("google-news-hi.xml"),
    [googleNewsSearchUrl("Rajasthan", "en")]: fixture("google-news-en.xml"),
    "https://feeds.example/bhaskar.xml": fixture("bhaskar-rajasthan.xml"),
    [googleTrendsUrl("IN")]: fixture("google-trends-in.xml"),
  };

  function fakeGet(extra: Record<string, string> = {}) {
    const asked: string[] = [];
    const get: TextGet = async (url) => {
      asked.push(url);
      const body = { ...served, ...extra }[url];
      if (body === undefined) throw new Error("HTTP 429 (rate limited)");
      return body;
    };
    return { get, asked };
  }

  it("asks each source once, and records each one's health in plain words, carrying lastSuccessAt over", async () => {
    const { get, asked } = fakeGet();
    const previous: SourceHealth[] = [{ name: "Down", group: "Publisher RSS", ok: true, at: "2026-10-28T10:00:00.000Z", items: 3, itemsLastRun: 3, lastSuccessAt: "2026-10-28T10:00:00.000Z" }];
    const { articles, topics, health } = await collectSources(get, plan, () => NOW, previous);
    expect(asked).toHaveLength(5);
    expect(new Set(asked).size).toBe(5);
    expect(articles.length).toBe(26);
    expect(topics).toHaveLength(5);
    expect(health.map((h) => [h.name, h.ok])).toEqual([["Google News (hi)", true], ["Google News (en)", true], ["Dainik Bhaskar", true], ["Down", false], ["Google Trends", true]]);
    expect(health[0]).toEqual({ name: "Google News (hi)", group: "News", ok: true, at: NOW.toISOString(), items: 10, itemsLastRun: 10, lastSuccessAt: NOW.toISOString() });
    expect(health.map((h) => h.group)).toEqual(["News", "News", "Publisher RSS", "Publisher RSS", "Trends"]);
    expect(health[3]).toEqual({
      name: "Down", group: "Publisher RSS", ok: false, at: NOW.toISOString(), items: 0, itemsLastRun: 0, lastSuccessAt: "2026-10-28T10:00:00.000Z",
      lastError: "Too many requests: the source asked us to slow down. Trying again later.",
    });
  });

  it("puts every failure in plain words", () => {
    expect(plainError(new Error("Timed out after 20 s"))).toBe("No answer in time. Trying again next run.");
    expect(plainError(new Error("fetch failed (ECONNRESET)"))).toBe("The connection was dropped by the source. Trying again next run.");
    expect(plainError(new Error("getaddrinfo ENOTFOUND x.in"))).toContain("DNS");
    expect(plainError(new Error("HTTP 503"))).toBe("The source answered with an error (HTTP 503).");
    expect(plainError(new SyntaxError("Unexpected token P in JSON"))).toBe("The answer was not in the expected format.");
  });

  it("reads TRENDS_RSS_FEEDS, and falls back to the default list", () => {
    expect(parseFeedList("A|https://a.in/rss, bad, B|http://b.in/rss ,C|https://c.in/x|national")).toEqual([
      { name: "A", url: "https://a.in/rss", rajasthan: true }, { name: "C", url: "https://c.in/x", rajasthan: false },
    ]);
    expect(parseFeedList("")).toBe(DEFAULT_FEEDS);
  });

  describe("GDELT, politely", () => {
    /** A fake clock that moves only when the gate sleeps (or the test moves it) */
    function clockGate() {
      let t = NOW.getTime();
      const gate = memoryPaceStore(() => t, async (ms: number) => void (t += ms));
      return { gate, tick: (ms: number) => void (t += ms), now: () => t };
    }

    /** GDELT answers from a script, one entry per call; records when each call was made */
    function gdeltWeb(script: (string | Error)[], clock: () => number) {
      const calls: { url: string; at: number }[] = [];
      const get: TextGet = async (url) => {
        if (!url.includes("gdeltproject")) throw new Error("HTTP 404");
        calls.push({ url, at: clock() });
        const next = script.shift() ?? fixture("gdelt-timelinevolraw.json");
        if (next instanceof Error) throw next;
        return next;
      };
      return { get, calls };
    }

    const topicRows = (districts: (string | null)[]): TrendRow[] =>
      districts.map((district, i) => ({
        type: "topics", window: "24h", rank: i + 1, title: `Topic ${i + 1}`, url: `https://t.in/${i}`, platform: "RSS", sourceName: "S",
        reasonWhy: "", superTag: "Politics", subTag: "", district, volume: "1 article", growth: "", shares: "", publishedAt: NOW, imageUrl: null, imageSource: null,
        headline: `Topic ${i + 1}`, summary: "", alert: null, clusterId: `t${i}`, clusterRank: i + 1, sources: [], score: 0,
      }));

    it("asks about the top topics, the minimum gap apart (12 s); topics with the same district share a call", async () => {
      const c = clockGate();
      const web = gdeltWeb([], c.now);
      const rows = topicRows(["Jaipur", "Sawai Madhopur", "Jaipur", "Kota"]);
      const health: SourceHealth[] = [];
      await addGdeltVolume(web.get, c.gate, rows, health, [], NOW);
      expect(web.calls.map((x) => decodeURIComponent(x.url.split("query=")[1]!.split("&")[0]!))).toEqual(["Jaipur Rajasthan", `"Sawai Madhopur" Rajasthan`]);
      expect(web.calls[1]!.at - web.calls[0]!.at).toBeGreaterThanOrEqual(GDELT_MIN_GAP_MS);
      expect(rows.slice(0, 3).every((r) => r.volume.endsWith("(GDELT)"))).toBe(true);
      expect(rows[3]!.volume).toBe("1 article");
      expect(health).toEqual([expect.objectContaining({ name: "GDELT", group: "Volume", ok: true, itemsLastRun: 3 })]);
    });

    it("backs off after a rate-limit reply (2 min, then 4), and says so in plain words", async () => {
      const c = clockGate();
      const web = gdeltWeb([new Error("HTTP 429 (rate limited)"), new Error("HTTP 429 (rate limited)")], c.now);
      const run = async () => {
        const health: SourceHealth[] = [];
        await addGdeltVolume(web.get, c.gate, topicRows(["Jaipur"]), health, [], NOW);
        return health[0]!;
      };
      expect(await run()).toMatchObject({ ok: false, lastError: "Too many requests: GDELT allows about one every 5 seconds. Pausing GDELT for 2 min." });
      expect(c.gate.states.get("gdelt")).toMatchObject({ failures: 1, backoffUntil: c.now() + 120_000 });
      // Within the pause: not asked at all
      c.tick(60_000);
      expect(await run()).toMatchObject({ ok: false, lastError: "Paused: GDELT asked us to slow down. Next try in about 1 min." });
      expect(web.calls).toHaveLength(1);
      c.tick(61_000);
      expect((await run()).lastError).toBe("Too many requests: GDELT allows about one every 5 seconds. Pausing GDELT for 4 min.");
      c.tick(241_000);
      expect(await run()).toMatchObject({ ok: true });
      expect(c.gate.states.get("gdelt")).toMatchObject({ failures: 0, backoffUntil: 0 });
    });

    it("reads GDELT's plain-text replies: the rate-limit note backs off, a query complaint does not", async () => {
      const c = clockGate();
      const web = gdeltWeb([
        "Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries.",
        "The specified phrase is too short.",
        new Error("fetch failed (ECONNRESET)"),
      ], c.now);
      await expect(gdeltTimeline(web.get, c.gate, "Rajasthan")).rejects.toThrow("Too many requests: GDELT allows about one every 5 seconds. Pausing GDELT for 2 min.");
      c.tick(130_000);
      await expect(gdeltTimeline(web.get, c.gate, "x")).rejects.toThrow("GDELT did not accept the query: The specified phrase is too short.");
      expect(c.gate.states.get("gdelt")!.backoffUntil).toBe(0);
      await expect(gdeltTimeline(web.get, c.gate, "Rajasthan")).rejects.toThrow("GDELT dropped the connection (it does this when busy or throttling). Pausing GDELT for 2 min.");
    });

    it("asks about the top topics in a full run and keeps the counts on those topics only", async () => {
      const c = clockGate();
      const { get } = fakeGet();
      const web = gdeltWeb([], c.now);
      const both: TextGet = (url) => (url.includes("gdeltproject") ? web.get(url) : get(url));
      const run = await runTrendSources(both, plan, tagger, NOW, c.gate);
      expect(run.health.at(-1)).toMatchObject({ name: "GDELT", ok: true });
      const top = run.rows.filter((r) => r.type === "topics" && r.window === "24h").slice(0, GDELT_TOPICS_PER_RUN).map((r) => r.title);
      const withGdelt = run.rows.filter((r) => r.volume.includes("GDELT"));
      expect(withGdelt.length).toBeGreaterThan(0);
      expect(withGdelt.every((r) => r.type === "topics" && top.includes(r.title))).toBe(true);
      expect(withGdelt.find((r) => r.window === "12h")!.growth).toBe("+200% in 6h");
      expect(web.calls.length).toBeLessThanOrEqual(GDELT_TOPICS_PER_RUN);
      expect(gdeltQuery({ district: null })).toBe("Rajasthan");
    });

    it("searches Google News in both editions for the text, articles only; GDELT only when a gate is given", async () => {
      const { get, asked } = fakeGet({ [googleNewsSearchUrl("पंचायत", "hi")]: fixture("google-news-hi.xml"), [googleNewsSearchUrl("पंचायत", "en")]: fixture("google-news-en.xml") });
      const { rows, health } = await searchTrendSources(get, "पंचायत", tagger, NOW, null);
      expect(asked).toEqual([googleNewsSearchUrl("पंचायत", "hi"), googleNewsSearchUrl("पंचायत", "en"), bingNewsUrl("पंचायत")]);
      expect(health.map((h) => [h.name, h.ok])).toEqual([["Google News (hi)", true], ["Google News (en)", true], ["Bing News", false]]);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.type === "articles" && r.window === "7d")).toBe(true);
      const c = clockGate();
      const withGate = await searchTrendSources(async (url) => (url.includes("gdeltproject") ? fixture("gdelt-timelinevolraw.json") : get(url)), "पंचायत", tagger, NOW, c.gate);
      expect(withGate.health.at(-1)).toMatchObject({ name: "GDELT", ok: true });
      expect(withGate.rows[0]!.volume).toBe("300 articles in 24h (GDELT)");
    });
  });
});
