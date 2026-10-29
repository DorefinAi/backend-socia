// Post metrics providers: fake numbers (deterministic, growing with age, marked as sample data) and the
// live readers against answers in the shape the platforms document. Never calls a platform.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FacebookMetricsProvider, FakeMetricsProvider, InstagramMetricsProvider, OAuth1Auth, XApiClient, XMetricsProvider, YoutubeMetricsProvider, dueBuckets, fakeSnapshot,
  makeMetricsProviders, metricsModes, type MetricPost,
} from "../src";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/metrics", name), "utf8");
const POSTED = new Date("2026-10-28T06:00:00Z");
const post = (over: Partial<MetricPost> = {}): MetricPost => ({ id: "11111111-1111-4111-8111-111111111111", platformPostId: "p1", publishedAt: POSTED, bucket: "24h", ...over });

/** A fetch that serves one body and records the URLs asked */
function http(body: string, status = 200) {
  const asked: string[] = [];
  const fn = (async (url: string | URL) => {
    asked.push(String(url));
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, asked };
}

describe("fake numbers", () => {
  it("are the same for the same post, grow with age, and say they are sample data", async () => {
    const a = fakeSnapshot("x", post({ bucket: "1h" }));
    expect(fakeSnapshot("x", post({ bucket: "1h" }))).toEqual(a);
    const later = fakeSnapshot("x", post({ bucket: "7d" }));
    expect(later.impressions!).toBeGreaterThan(a.impressions!);
    expect(later.likes!).toBeGreaterThanOrEqual(a.likes!);
    expect(a.raw).toMatchObject({ source: "fake", platform: "x", bucket: "1h" });
    const other = fakeSnapshot("x", post({ id: "22222222-2222-4222-8222-222222222222", bucket: "1h" }));
    expect(other.impressions).not.toBe(a.impressions);
    // Plausible: engagement well under impressions
    const engaged = later.likes! + later.reposts! + later.replies! + later.quotes!;
    expect(engaged).toBeLessThan(later.impressions! * 0.06);
    expect(fakeSnapshot("youtube", post()).reposts).toBeNull();
    expect((await new FakeMetricsProvider("facebook").fetch([post()])).get(post().id)!.raw.source).toBe("fake");
  });
});

describe("live readers (recorded answers)", () => {
  it("X: public metrics through the X client, 100 ids per call", async () => {
    const { fn, asked } = http(fixture("x-tweets.json"));
    const client = new XApiClient({ username: "first", auth: new OAuth1Auth({ consumerKey: "k", consumerSecret: "s", token: "t", tokenSecret: "ts" }), fetch: fn });
    const got = await new XMetricsProvider(client).fetch([post({ platformPostId: "1850000000000000001" })]);
    expect(asked[0]).toMatch(/^https:\/\/api\.x\.com\/2\/tweets\?ids=1850000000000000001&tweet\.fields=public_metrics$/);
    expect(got.get(post().id)).toMatchObject({ impressions: 5400, likes: 88, reposts: 12, replies: 4, quotes: 2, bookmarks: 5, raw: { source: "live" } });
    const many = await new XMetricsProvider({ metrics: async (ids) => (asked.push(ids.join(",")), {}) }).fetch(Array.from({ length: 150 }, (_, i) => post({ id: `id${i}`, platformPostId: `x${i}` })));
    expect(many.size).toBe(0);
    expect(asked.slice(1).map((a) => a.split(",").length)).toEqual([100, 50]);
  });

  it("Facebook: views (post_media_view), reactions, comments, shares; the page prefix added to a bare id", async () => {
    const { fn, asked } = http(fixture("facebook-post.json"));
    const got = await new FacebookMetricsProvider({ pageToken: "PAGE-TOKEN", pageId: "123", http: fn }).fetch([post({ platformPostId: "456" })]);
    expect(asked[0]).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/123_456\?fields=/);
    expect(decodeURIComponent(asked[0]!)).toContain("insights.metric(post_media_view,post_video_views)");
    expect(got.get(post().id)).toMatchObject({ impressions: 9876, likes: 212, replies: 31, reposts: 14, videoViews: 4410, quotes: null });
  });

  it("Instagram: media insights views, likes, comments, shares, saved", async () => {
    const { fn, asked } = http(fixture("instagram-insights.json"));
    const got = await new InstagramMetricsProvider({ pageToken: "T", igUserId: "1784", http: fn }).fetch([post({ platformPostId: "17900" })]);
    expect(asked[0]).toContain("/17900/insights?metric=views,reach,likes,comments,shares,saved");
    expect(got.get(post().id)).toMatchObject({ impressions: 15320, likes: 640, replies: 28, reposts: 51, bookmarks: 19 });
  });

  it("YouTube: video statistics, 50 ids per call", async () => {
    const { fn, asked } = http(fixture("youtube-videos.json"));
    const got = await new YoutubeMetricsProvider({ apiKey: "KEY", http: fn }).fetch([post({ platformPostId: "dQw4w9WgXcQ" }), post({ id: "other", platformPostId: "gone" })]);
    expect(asked[0]).toMatch(/^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?part=statistics&id=dQw4w9WgXcQ%2Cgone&key=KEY$/);
    expect(got.get(post().id)).toMatchObject({ impressions: 48210, likes: 1320, replies: 96, videoViews: 48210 });
    expect(got.has("other")).toBe(false);
  });

  it("an error answer is an error, without the access token in it", async () => {
    const { fn } = http(`{"error":{"message":"Invalid OAuth access token","url":"https://graph.facebook.com/x?access_token=SECRET123"}}`, 400);
    const err = await new FacebookMetricsProvider({ pageToken: "SECRET123", pageId: "1", http: fn }).fetch([post()]).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 400/);
    expect(String(err)).not.toContain("SECRET123");
  });
});

describe("modes and due buckets", () => {
  it("fake unless METRICS_*_MODE=live; live without its keys stops at start", () => {
    expect(metricsModes({})).toEqual({ x: "fake", facebook: "fake", instagram: "fake", youtube: "fake" });
    expect(metricsModes({ METRICS_YOUTUBE_MODE: "LIVE" }).youtube).toBe("live");
    const p = makeMetricsProviders({});
    expect(Object.values(p).map((x) => x.mode)).toEqual(["fake", "fake", "fake", "fake"]);
    expect(() => makeMetricsProviders({ METRICS_FACEBOOK_MODE: "live" })).toThrow(/META_PAGE_TOKEN is not set/);
    expect(() => makeMetricsProviders({ METRICS_X_MODE: "live" })).toThrow(/X_/);
    expect(makeMetricsProviders({ METRICS_YOUTUBE_MODE: "live", YT_API_KEY: "k" }).youtube.mode).toBe("live");
  });

  it("each bucket once when due; live numbers only for the current age", () => {
    const at = (h: number) => new Date(POSTED.getTime() + h * 3600_000);
    expect(dueBuckets(POSTED, at(0.5), new Set(), "fake")).toEqual([]);
    expect(dueBuckets(POSTED, at(1), new Set(), "fake")).toEqual(["1h"]);
    expect(dueBuckets(POSTED, at(30), new Set(["1h"]), "fake")).toEqual(["6h", "24h"]);
    expect(dueBuckets(POSTED, at(30), new Set(["1h"]), "live")).toEqual(["24h"]);
    expect(dueBuckets(POSTED, at(30), new Set(["1h", "24h"]), "live")).toEqual([]);
    expect(dueBuckets(POSTED, at(24 * 8), new Set(["1h", "6h", "24h", "3d", "7d"]), "fake")).toEqual([]);
  });
});
