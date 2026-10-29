// Web Scraper v2 (handoff/scraper-analytics-contract.md §A): the Rajasthan feeds added on 29 Oct 2026,
// the same story from several publishers as one cluster, districts (including a local channel's),
// keyword watches, and YouTube read every 30 minutes. Recorded fixtures only; no network.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLUSTER_RULE, DEFAULT_FEEDS, PACE, TREND_ARTICLE_POOL, TREND_TOP, buildTrends, clusterStories, collectSources, memoryPaceStore, parseRss, parseYoutubeChannels,
  storyKey, storyLikeness, trendTagger, watchHits, watchKey, youtubeFeedUrl, type RawArticle, type SourcePlan, type TextGet,
} from "../src";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/trends", name), "utf8");
const NOW = new Date("2026-10-29T06:00:00Z");
const tagger = trendTagger([]);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

const article = (title: string, extra: Partial<RawArticle> = {}): RawArticle => ({
  title, url: `https://example.in/${encodeURIComponent(title).slice(0, 40)}`, sourceName: "Test", platform: "RSS", publishedAt: hoursAgo(1), description: "",
  imageUrl: null, imageSource: null, rajasthanFeed: true, ...extra,
});

describe("the Rajasthan feeds added on 29 Oct 2026", () => {
  const feeds = [
    ["patrika-rajasthan.xml", "Rajasthan Patrika"],
    ["news18-rajasthan.xml", "News18 Rajasthan"],
    ["tv9-rajasthan.xml", "TV9 Bharatvarsh Rajasthan"],
    ["abp-rajasthan.xml", "ABP Live Rajasthan"],
  ] as const;

  it.each(feeds)("%s parses: titles, https links, dates, plain-text summaries", (file, name) => {
    const items = parseRss(fixture(file), { name, platform: "RSS", rajasthan: true });
    expect(items).toHaveLength(4);
    for (const i of items) {
      expect(i.title.length).toBeGreaterThan(10);
      expect(i.url).toMatch(/^https:\/\//);
      expect(i.publishedAt).toBeInstanceOf(Date);
      expect(i.description).not.toMatch(/[<>]|&[a-z]+;|&#\d+;/);
    }
  });

  it("News18 carries a picture; ABP's entity-encoded HTML summary comes out as text", () => {
    const news18 = parseRss(fixture("news18-rajasthan.xml"), { name: "News18 Rajasthan", platform: "RSS", rajasthan: true });
    expect(news18[0]!.imageUrl).toMatch(/^https:\/\//);
    const abp = parseRss(fixture("abp-rajasthan.xml"), { name: "ABP Live Rajasthan", platform: "RSS", rajasthan: true });
    expect(abp[0]!.description).toContain("सतलज");
  });

  it("are in the default list, Rajasthan feeds all", () => {
    const names = DEFAULT_FEEDS.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Rajasthan Patrika", "Patrika Jaipur", "News18 Rajasthan", "TV9 Bharatvarsh Rajasthan", "ABP Live Rajasthan"]));
    expect(DEFAULT_FEEDS.filter((f) => /patrika|news18|tv9|abplive/.test(f.url)).every((f) => f.rajasthan && f.url.startsWith("https://"))).toBe(true);
    expect(new Set(DEFAULT_FEEDS.map((f) => f.url)).size).toBe(DEFAULT_FEEDS.length);
  });
});

describe("same story, different publishers", () => {
  // Real headlines of 28 Oct 2026
  const asaram = [
    article("जोधपुर: आसाराम की पैरोल खत्म, देर रात जेल पहुंचने पर क्यों नहीं मिली एंट्री?", { sourceName: "ABP Live Rajasthan", url: "https://abp.in/a" }),
    article("Asaram News: पैरोल खत्म होने के बाद जोधपुर सेंट्रल जेल में लेट पहुंचे आसाराम, दर्ज हुआ एक और केस", { sourceName: "News18 Rajasthan", url: "https://n18.in/a" }),
    article("पैरोल खत्म होने के बाद जोधपुर जेल पहुंचने में हुई देरी तो बढ़ गई आसाराम की मुश्किलें, जानिए पूरा मामला", { sourceName: "Patrika Jodhpur", url: "https://patrika.in/a" }),
  ];
  const others = [
    article("सिरोही में पंचायतीराज चुनाव की वोटिंग आज, 3.54 लाख मतदाता करेंगे मतदान", { url: "https://x.in/1" }),
    article("राजस्थान पंचायत चुनाव में 80.09% मतदान, कहीं झड़प तो कहीं बोगस वोटिंग के लगे आरोप", { url: "https://x.in/2" }),
    article("Jaipur metro phase 2 gets final approval from the Centre", { url: "https://x.in/3" }),
  ];

  it("groups the same story told in different words, and keeps two reports on one theme apart", () => {
    const idx = clusterStories([...asaram, ...others]);
    expect(new Set(idx.slice(0, 3)).size).toBe(1);
    expect(new Set(idx).size).toBe(4);
    expect(idx[3]).not.toBe(idx[4]);
  });

  it("only within 24 h of each other", () => {
    const later = { ...asaram[1]!, publishedAt: new Date(asaram[0]!.publishedAt!.getTime() + (CLUSTER_RULE.hours + 2) * 3600_000) };
    const idx = clusterStories([asaram[0]!, later]);
    expect(idx[0]).not.toBe(idx[1]);
  });

  it("short titles only match word for word; Rajasthan alone says nothing", () => {
    expect(storyLikeness(storyKey("Jaipur rain", null), storyKey("Jaipur rains", null))).toBe(0);
    expect(storyLikeness(storyKey("Rajasthan news today", null), storyKey("Rajasthan news update", null))).toBe(0);
    expect(storyLikeness(storyKey("Jaipur metro phase two approved", null), storyKey("Jaipur metro phase two approved", null))).toBe(1);
  });

  it("buildTrends: one clusterId per story, sources one per publisher, and topics share their lead article's story", () => {
    const rows = buildTrends({ articles: [...asaram, ...others], topics: [] }, tagger, NOW);
    const day = rows.filter((r) => r.type === "articles" && r.window === "24h");
    const story = day.filter((r) => r.title.includes("आसाराम"));
    expect(story).toHaveLength(3);
    expect(new Set(story.map((r) => r.clusterId)).size).toBe(1);
    expect(new Set(story.map((r) => r.clusterRank)).size).toBe(1);
    expect(story[0]!.sources.map((s) => s.name).sort()).toEqual(["ABP Live Rajasthan", "News18 Rajasthan", "Patrika Jodhpur"]);
    expect(story[0]!.sources[0]).toEqual({ name: expect.any(String), url: expect.stringMatching(/^https:/), publishedAt: expect.any(String) });
    expect(story.every((r) => r.district === "Jodhpur")).toBe(true);
    // Rows of a story are numbered together, stories in rank order
    const ranks = day.map((r) => r.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    // The same lead gives the same id in the next run
    const again = buildTrends({ articles: [...asaram, ...others], topics: [] }, tagger, new Date(NOW.getTime() + 900_000));
    expect(again.find((r) => r.type === "articles" && r.url === "https://abp.in/a")!.clusterId).toBe(story[0]!.clusterId);
    const topic = rows.find((r) => r.type === "topics" && r.window === "24h" && r.title.includes("आसाराम"));
    expect(topic && story.map((r) => r.clusterId)).toContain(topic!.clusterId);
  });

  it("keeps a pool of stories beyond the top 20, and any story matching a watched keyword", () => {
    const many = Array.from({ length: TREND_ARTICLE_POOL + 10 }, (_, i) => {
      const c = String.fromCodePoint(0x4e00 + i * 7);
      return article(`Rajasthan ${c.repeat(3)} ${c.repeat(4)} ${c.repeat(5)}`, { url: `https://r.in/${i}` });
    });
    const far = article("Mumbai harbour 쉼표 update", { url: "https://far.in/1", rajasthanFeed: false, publishedAt: hoursAgo(20) });
    const plain = buildTrends({ articles: [...many, far], topics: [] }, tagger, NOW).filter((r) => r.type === "articles" && r.window === "24h");
    expect(new Set(plain.map((r) => r.clusterId)).size).toBe(TREND_ARTICLE_POOL);
    expect(plain.some((r) => r.url === far.url)).toBe(false);
    expect(plain.filter((r) => r.clusterRank <= TREND_TOP)).toHaveLength(TREND_TOP);
    const watched = buildTrends({ articles: [...many, far], topics: [], watch: ["HARBOUR"] }, tagger, NOW).filter((r) => r.type === "articles" && r.window === "24h");
    expect(watched.find((r) => r.url === far.url)?.clusterRank).toBe(TREND_ARTICLE_POOL + 1);
  });
});

describe("districts", () => {
  it("from the title or summary, either script; a local channel's district when the text names none", () => {
    const rows = buildTrends({
      articles: [
        article("सवाई माधोपुर में बाघिन का नया शावक दिखा", { url: "https://a.in/1" }),
        article("Leopard spotted near school", { url: "https://a.in/2", description: "Residents of Udaipur's Badgaon area alerted the forest team." }),
        article("गांव में भव्य मेला शुरू", { url: "https://youtube.com/watch?v=1", platform: "YouTube", district: "Bhilwara" }),
        article("जयपुर की खबर, चैनल भीलवाड़ा का", { url: "https://youtube.com/watch?v=2", platform: "YouTube", district: "Bhilwara" }),
        article("Delhi traffic advisory", { url: "https://a.in/3" }),
      ],
      topics: [],
    }, tagger, NOW);
    const d = (url: string) => rows.find((r) => r.type === "articles" && r.url === url)!.district;
    expect([d("https://a.in/1"), d("https://a.in/2"), d("https://youtube.com/watch?v=1"), d("https://youtube.com/watch?v=2"), d("https://a.in/3")])
      .toEqual(["Sawai Madhopur", "Udaipur", "Bhilwara", "Jaipur", null]);
  });

  it("the channel list keeps a district per channel", () => {
    expect(parseYoutubeChannels([{ id: "UCfnvGSUXKIuaCv-9E9a2UJg", name: "Zee Rajasthan News" }, { id: "UCS0i_fKVNJ9t31h_HotGupw", name: "Jaipur Times", district: "Jaipur" }])).toEqual([
      { name: "Zee Rajasthan News", channelId: "UCfnvGSUXKIuaCv-9E9a2UJg" },
      { name: "Jaipur Times", channelId: "UCS0i_fKVNJ9t31h_HotGupw", district: "Jaipur" },
    ]);
  });
});

describe("keyword watch", () => {
  it("case-insensitive substring, Devanagari spellings folded, vowel signs kept", () => {
    const text = "JDA ने जयपुर मेट्रो फेज़-2 की नई सड़क को मंज़ूरी दी; Metro work starts";
    expect(watchHits(["metro", "जयपुर", "फेज-2", "मंजूरी", "जैपुर", "Ajmer"], text)).toEqual(["metro", "जयपुर", "फेज-2", "मंजूरी"]);
    // Substring: a keyword inside a longer word counts
    expect(watchHits(["जयपुर"], "जयपुरवासियों के लिए")).toEqual(["जयपुर"]);
    expect(watchHits(["!!!"], "anything")).toEqual([]);
    expect(watchKey(" !! ")).toBe("");
    expect(watchKey("Jaipur  Metro")).toBe("jaipur metro");
  });
});

describe("YouTube, read every 30 minutes", () => {
  const channels = parseYoutubeChannels([
    { id: "UCfnvGSUXKIuaCv-9E9a2UJg", name: "Zee Rajasthan News" },
    { id: "UCS0i_fKVNJ9t31h_HotGupw", name: "Jaipur Times", district: "Jaipur" },
  ]);
  const plan: SourcePlan = { googleNews: { hi: "", en: "" }, feeds: [], geo: "", gdelt: false, youtube: channels };

  it("one request per channel, the channel's name as source, then the kept answer until the 30 minutes are up", async () => {
    let clock = NOW.getTime();
    const store = memoryPaceStore(() => clock, async (ms) => void (clock += ms));
    const asked: string[] = [];
    const get: TextGet = async (url) => (asked.push(url), fixture("youtube-channel.xml"));
    const first = await collectSources(get, plan, () => new Date(clock), [], store, tagger);
    expect(asked).toEqual(channels.map((c) => youtubeFeedUrl(c.channelId)));
    expect(first.health).toEqual([expect.objectContaining({ name: "YouTube", ok: true })]);
    expect(new Set(first.articles.map((a) => a.sourceName))).toEqual(new Set(["Zee Rajasthan News", "Jaipur Times"]));
    expect(first.articles.filter((a) => a.sourceName === "Jaipur Times").every((a) => a.district === "Jaipur")).toBe(true);

    clock += 15 * 60_000;
    const second = await collectSources(get, plan, () => new Date(clock), [], store, tagger);
    expect(asked).toHaveLength(2);
    expect(second.articles).toHaveLength(first.articles.length);
    expect(second.articles[0]!.publishedAt).toBeInstanceOf(Date);

    clock += PACE.youtube.minGapMs;
    await collectSources(get, plan, () => new Date(clock), [], store, tagger);
    expect(asked).toHaveLength(4);
  });

  it("every channel failing is a failed source, in plain words", async () => {
    const get: TextGet = async () => { throw new Error("HTTP 404"); };
    const { health, articles } = await collectSources(get, plan, () => NOW, [], memoryPaceStore(() => NOW.getTime(), async () => undefined), tagger);
    expect(articles).toEqual([]);
    expect(health[0]).toMatchObject({ name: "YouTube", ok: false, lastError: "The source answered with an error (HTTP 404)." });
  });
});
