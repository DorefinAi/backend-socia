// The added free sources (Bing News, publisher feeds, PIB, NDMA Sachet alerts, Hindi Wikipedia, Reddit,
// YouTube channel feeds), plain text, and how the slow sources are paced. Recorded or synthetic
// fixtures only; no network here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_NEWS_TOP_HI, PIB_URL, SACHET_URL, YOUTUBE_GAP_MS, alertFor, alertLevel, bingNewsUrl, buildTrends, cleanText, collectSources, cutText,
  googleTrendsUrl, isRajasthanAlert, memoryPaceStore, parseAtom, parseCap, parseRss, parseSachetRss, parseWikiTop, parseYoutubeChannels, redditUrl,
  trendTagger, wikiTopUrl, youtubeFeedUrl, type SourcePlan, type TextGet, type TrendAlert,
} from "../src";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/trends", name), "utf8");
const NOW = new Date("2026-10-28T18:00:00Z");
const tagger = trendTagger([]);

describe("plain text", () => {
  it("decodes entities and strips HTML, including HTML sent entity-encoded", () => {
    expect(cleanText("<![CDATA[ <p>पहला &amp; <b>दूसरा</b></p> ]]>")).toBe("पहला & दूसरा");
    expect(cleanText("&lt;p&gt;Rain in &lt;a href=&quot;x&quot;&gt;Jaipur&lt;/a&gt;&amp;nbsp;today&lt;/p&gt;")).toBe("Rain in Jaipur today");
    expect(cleanText("<script>alert(1)</script>Safe")).toBe("Safe");
  });

  it("cuts on a word, never mid-word, with an ellipsis", () => {
    expect(cutText("short", 10)).toBe("short");
    const cut = cutText("जयपुर में आज सुबह से तेज बारिश हो रही है और कई इलाकों में पानी भरा", 30);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(30);
    expect("जयपुर में आज सुबह से तेज बारिश हो रही है".startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.slice(0, -1).endsWith(" ")).toBe(false);
  });
});

describe("the added feeds", () => {
  it("Bing News: the article link is taken out of Bing's redirect, the publisher from News:Source", () => {
    const items = parseRss(fixture("bing-rajasthan.xml"), { name: "Bing News", platform: "Bing News", rajasthan: true });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.url).toMatch(/^https:\/\/www\.news18\.com\//);
    expect(items[0]!.sourceName).toBe("News18");
    expect(items.every((i) => !i.url.includes("bing.com"))).toBe(true);
  });

  it("publisher, top-stories and PIB feeds parse; PIB has no dates", () => {
    for (const [file, name] of [["indianexpress-jaipur.xml", "Indian Express"], ["ndtv-india.xml", "NDTV India"], ["the-hindu.xml", "The Hindu"]] as const) {
      const items = parseRss(fixture(file), { name, platform: "RSS", rajasthan: false });
      expect(items.length, file).toBeGreaterThan(0);
      expect(items.every((i) => i.title && i.url.startsWith("https://") && !/[<>]/.test(i.description)), file).toBe(true);
    }
    expect(parseRss(fixture("google-news-top-hi.xml"), { name: "Google News", platform: "Google News", rajasthan: false })).toHaveLength(5);
    const pib = parseRss(fixture("pib-hi.xml"), { name: "PIB", platform: "Government", rajasthan: false });
    expect(pib).toHaveLength(4);
    expect(pib[0]!.url).toMatch(/^https:\/\/pib\.gov\.in\/PressReleaseIframePage\.aspx\?PRID=\d+$/);
    expect(pib[0]!.publishedAt).toBeNull();
  });

  it("Reddit (Atom): title, link, preview picture, plain text", () => {
    const posts = parseAtom(fixture("reddit-rajasthan.xml"), { name: "Reddit r/rajasthan", platform: "Reddit", rajasthan: true });
    expect(posts).toHaveLength(3);
    expect(posts[0]!.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/Rajasthan\/comments\//);
    expect(posts[0]!.sourceName).toBe("Reddit r/rajasthan");
    expect(posts.some((p) => p.imageUrl?.startsWith("https://"))).toBe(true);
  });

  it("YouTube channel feed (Atom, no key): video link, thumbnail, channel as publisher, plain description", () => {
    const [v] = parseAtom(fixture("youtube-channel.xml"), { name: "Fallback", platform: "YouTube", rajasthan: true });
    expect(v).toMatchObject({
      title: "जयपुर में तेज बारिश, कई इलाकों में जलभराव | Rajasthan Weather", url: "https://www.youtube.com/watch?v=abcdefghijk", platform: "YouTube",
      sourceName: "Example Rajasthan News", imageUrl: "https://i2.ytimg.com/vi/abcdefghijk/hqdefault.jpg", imageSource: "Example Rajasthan News",
      description: "शहर में दो घंटे की बारिश से जलभराव हुआ। नगर निगम की टीमें मौके पर।",
    });
    expect(v!.publishedAt?.toISOString()).toBe("2026-10-28T15:00:00.000Z");
  });

  it("reads the channel list in either shape and keeps only real channel ids", () => {
    const id = "UC" + "a".repeat(22);
    expect(parseYoutubeChannels([{ name: "A", channelId: id }, { name: "dup", channel_id: id }, { title: "B", id: "UC" + "b".repeat(22) }, { name: "bad", channelId: "xyz" }])).toEqual([
      { name: "A", channelId: id }, { name: "B", channelId: "UC" + "b".repeat(22) },
    ]);
    expect(parseYoutubeChannels({ channels: [{ name: "A", channelId: id }] })).toEqual([{ name: "A", channelId: id }]);
    expect(parseYoutubeChannels(null)).toEqual([]);
  });

  it("Hindi Wikipedia most-read: the main page, special pages and namespaces are left out", () => {
    const topics = parseWikiTop(JSON.parse(fixture("wikipedia-top-hi.json")), new Date("2026-10-27T00:00:00Z"));
    expect(topics.some((t) => t.title === "मुखपृष्ठ" || t.title.includes(":"))).toBe(false);
    expect(topics[0]).toMatchObject({ title: "हनुमान चालीसा", platform: "Wikipedia", volume: "2.1K views", url: "https://hi.wikipedia.org/wiki/%E0%A4%B9%E0%A4%A8%E0%A5%81%E0%A4%AE%E0%A4%BE%E0%A4%A8_%E0%A4%9A%E0%A4%BE%E0%A4%B2%E0%A5%80%E0%A4%B8%E0%A4%BE" });
    expect(topics[0]!.publishedAt?.toISOString()).toBe("2026-10-27T23:59:59.000Z");
    expect(wikiTopUrl(new Date("2026-10-27T10:00:00Z"))).toBe("https://wikimedia.org/api/rest_v1/metrics/pageviews/top/hi.wikipedia/all-access/2026/10/27");
  });
});

describe("NDMA Sachet alerts", () => {
  it("keeps Rajasthan's alerts only (IMD Jaipur, Rajasthan SDMA, or naming Rajasthan)", () => {
    expect(parseSachetRss(fixture("sachet-india.xml")).filter(isRajasthanAlert)).toEqual([]);
    const ours = parseSachetRss(fixture("sachet-rajasthan.xml")).filter(isRajasthanAlert);
    expect(ours.map((a) => a.issuer)).toEqual(["IMD Jaipur", "Rajasthan SDMA"]);
  });

  it("reads validity and severity from the CAP file, and the level from IMD's colour or the severity", () => {
    expect(parseCap(fixture("cap-jaipur.xml"))).toMatchObject({ event: "Heavy Rain", severity: "Severe", area: "3 districts of Rajasthan" });
    expect(parseCap(fixture("cap-jaipur.xml"))!.expires!.toISOString()).toBe("2026-10-28T19:00:00.000Z");
    expect([alertLevel("ऑरेंज अलर्ट", ""), alertLevel("Red alert issued", "Moderate"), alertLevel("", "Extreme"), alertLevel("", "Severe"), alertLevel("", "Moderate"), alertLevel("", "Minor")])
      .toEqual(["orange", "red", "red", "orange", "yellow", "info"]);
  });

  it("puts the badge on weather items and hashtags of the districts it covers", () => {
    const alert: TrendAlert = {
      level: "orange", text: "भारी बारिश की संभावना", event: "Heavy Rain", severity: "Severe", validFrom: null, validUntil: "2026-10-28T19:00:00.000Z",
      districts: ["Jaipur", "Tonk"], issuer: "IMD Jaipur", url: "https://sachet.ndma.gov.in/x", source: "NDMA Sachet",
    };
    expect(alertFor({ type: "topics", district: "Jaipur", superTag: "Weather" }, [alert])).toEqual({ level: "orange", title: "भारी बारिश की संभावना", validUntil: "2026-10-28T19:00:00.000Z" });
    expect(alertFor({ type: "hashtags", district: "Tonk", superTag: "Politics" }, [alert])).not.toBeNull();
    expect(alertFor({ type: "topics", district: "Jaipur", superTag: "Politics" }, [alert])).toBeNull();
    expect(alertFor({ type: "topics", district: "Kota", superTag: "Weather" }, [alert])).toBeNull();
    const rows = buildTrends({ articles: [{
      title: "जयपुर में तेज बारिश का अलर्ट", url: "https://j.in/1", sourceName: "S", platform: "RSS", publishedAt: NOW, description: "", imageUrl: null, imageSource: null, rajasthanFeed: true,
    }], topics: [], alerts: [alert] }, tagger, NOW);
    expect(rows.find((r) => r.type === "articles")!.alert).toMatchObject({ level: "orange" });
  });
});

describe("collecting every source, politely", () => {
  const plan: SourcePlan = {
    googleNews: { hi: "", en: "" }, googleNewsTop: true, bing: "Rajasthan", feeds: [], government: { pib: true, sachet: true }, geo: "IN", gdelt: false,
    reddit: "rajasthan", wikipedia: true,
    youtube: [{ name: "A", channelId: "UC" + "a".repeat(22) }, { name: "B", channelId: "UC" + "b".repeat(22) }],
  };

  function web(clock: () => number) {
    const asked: { url: string; at: number }[] = [];
    const served: Record<string, string> = {
      [GOOGLE_NEWS_TOP_HI]: fixture("google-news-top-hi.xml"),
      [bingNewsUrl("Rajasthan")]: fixture("bing-rajasthan.xml"),
      [PIB_URL]: fixture("pib-hi.xml"),
      [SACHET_URL]: fixture("sachet-rajasthan.xml"),
      "https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=9000000000000001": fixture("cap-jaipur.xml"),
      [googleTrendsUrl("IN")]: fixture("google-trends-in.xml"),
      [wikiTopUrl(new Date(NOW.getTime() - 86400_000))]: fixture("wikipedia-top-hi.json"),
      [redditUrl("rajasthan")]: fixture("reddit-rajasthan.xml"),
      [youtubeFeedUrl("UC" + "a".repeat(22))]: fixture("youtube-channel.xml"),
    };
    const get: TextGet = async (url) => {
      asked.push({ url, at: clock() });
      if (served[url] === undefined) throw new Error("HTTP 404");
      return served[url]!;
    };
    return { get, asked };
  }

  it("reads each source once, groups their health, keeps the alerts, and spaces YouTube channels a second apart", async () => {
    let t = NOW.getTime();
    const store = memoryPaceStore(() => t, async (ms: number) => void (t += ms));
    const w = web(() => t);
    const { articles, topics, alerts, health } = await collectSources(w.get, plan, () => NOW, [], store, tagger);
    expect(health.map((h) => [h.name, h.group, h.ok])).toEqual([
      ["Google News top stories", "News", true], ["Bing News", "News", true], ["PIB", "Government", true], ["NDMA Sachet", "Government", true],
      ["Google Trends", "Trends", true], ["Hindi Wikipedia", "Trends", true], ["Reddit r/rajasthan", "Social", true], ["YouTube", "YouTube", true],
    ]);
    expect(articles.some((a) => a.platform === "YouTube")).toBe(true);
    expect(articles.some((a) => a.platform === "Reddit")).toBe(true);
    expect(topics.some((x) => x.platform === "Wikipedia")).toBe(true);
    // The fog alert's CAP file is missing (404): its expiry is unknown, so it is kept, state-wide, at "info"
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ level: "info", districts: [], validUntil: null, issuer: "Rajasthan SDMA", text: "Dense fog likely over parts of Rajasthan tonight." });
    expect(alerts[0]).toMatchObject({ level: "orange", districts: ["Jaipur", "Tonk", "Sawai Madhopur"], validUntil: "2026-10-28T19:00:00.000Z", issuer: "IMD Jaipur" });
    const yt = w.asked.filter((a) => a.url.includes("youtube.com"));
    expect(yt).toHaveLength(2);
    expect(yt[1]!.at - yt[0]!.at).toBeGreaterThanOrEqual(YOUTUBE_GAP_MS);
    expect(health.find((h) => h.name === "YouTube")!.items).toBe(1); // one channel answered, one did not: still a working source

    // An hour has not passed: Reddit and Wikipedia are not asked again, their last answer is reused
    w.asked.length = 0;
    t += 10 * 60_000;
    const again = await collectSources(w.get, plan, () => new Date(t), health, store, tagger);
    expect(w.asked.some((a) => a.url.includes("reddit.com") || a.url.includes("wikimedia.org"))).toBe(false);
    const reddit = again.health.find((h) => h.name === "Reddit r/rajasthan")!;
    expect(reddit).toMatchObject({ ok: true, items: 3, at: NOW.toISOString() });
    expect(again.articles.filter((a) => a.platform === "Reddit")[0]!.publishedAt).toBeInstanceOf(Date);
  });

  it("backs off Reddit for an hour after a 429, keeping its last answer", async () => {
    let t = NOW.getTime();
    const store = memoryPaceStore(() => t, async (ms: number) => void (t += ms));
    const only: SourcePlan = { googleNews: { hi: "", en: "" }, feeds: [], geo: "", gdelt: false, reddit: "rajasthan" };
    let status = 200;
    const get: TextGet = async () => {
      if (status === 429) throw new Error("HTTP 429 (rate limited)");
      return fixture("reddit-rajasthan.xml");
    };
    expect((await collectSources(get, only, () => new Date(t), [], store)).articles).toHaveLength(3);
    t += 3600_000 + 1;
    status = 429;
    const refused = await collectSources(get, only, () => new Date(t), [], store);
    expect(refused.health[0]).toMatchObject({ ok: false, lastError: "Too many requests: Reddit asks for few requests. Pausing Reddit for 60 min." });
    t += 60_000;
    const paused = await collectSources(get, only, () => new Date(t), [], store);
    expect(paused.health[0]).toMatchObject({ ok: true, items: 3 });
  });
});
