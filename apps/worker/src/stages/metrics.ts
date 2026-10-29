// Worker role "metrics": every METRICS_POLL_SECONDS, each posted item's numbers are captured once per age
// bucket (1h, 6h, 24h, 3d, 7d) when due, through the platform's provider (fake locally, live with keys).

import { metricsCandidates, saveMetrics, type Db, type MetricsRow } from "@socia/db";
import { METRIC_PLATFORMS, dueBuckets, type MetricPlatform, type MetricPost, type MetricSnapshot, type MetricsProvider } from "@socia/providers";
import type { Logger } from "pino";

export class MetricsJob {
  private lastRunAt = 0;

  constructor(
    private readonly deps: { db: Db; providers: Record<MetricPlatform, MetricsProvider>; pollMs: number; log: Logger; now?: () => Date },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Called every few seconds by the loop; runs when due */
  async tick(): Promise<boolean> {
    if (this.now().getTime() - this.lastRunAt < this.deps.pollMs) return false;
    await this.run();
    return false;
  }

  /** One pass: every due bucket of every recent post. Returns the rows written. */
  async run(): Promise<number> {
    const { db, providers, log } = this.deps;
    const now = this.now();
    this.lastRunAt = now.getTime();
    const candidates = await metricsCandidates(db, now);
    const due = new Map<MetricPlatform, (MetricPost & { orgId: string })[]>();
    for (const c of candidates) {
      if (!METRIC_PLATFORMS.includes(c.platform as MetricPlatform)) continue;
      const platform = c.platform as MetricPlatform;
      for (const bucket of dueBuckets(c.publishedAt, now, new Set(c.have), providers[platform].mode)) {
        due.set(platform, [...(due.get(platform) ?? []), { id: c.id, orgId: c.orgId, platformPostId: c.platformPostId, publishedAt: c.publishedAt, bucket }]);
      }
    }
    let written = 0;
    for (const [platform, posts] of due) {
      const provider = providers[platform];
      // Live: one call per post (several due buckets share the answer). Fake numbers depend on the bucket.
      const unique = [...new Map(posts.map((p) => [p.id, p])).values()];
      let snapshots: Map<string, MetricSnapshot>;
      try {
        snapshots = provider.mode === "live" ? await provider.fetch(unique) : new Map();
      } catch (err) {
        // Keys wrong, rate limited, platform down: nothing written, tried again next pass
        log.warn({ platform, mode: provider.mode, posts: unique.length, err: String((err as Error)?.message ?? err) }, "metrics: provider failed");
        continue;
      }
      const rows: MetricsRow[] = [];
      for (const p of posts) {
        const s = provider.mode === "live" ? snapshots.get(p.id) : (await provider.fetch([p])).get(p.id);
        if (!s) continue;
        rows.push({
          orgId: p.orgId, postId: p.id, platform, ageBucket: p.bucket, capturedAt: now, impressions: s.impressions, likes: s.likes, reposts: s.reposts,
          replies: s.replies, quotes: s.quotes, bookmarks: s.bookmarks, videoViews: s.videoViews, raw: s.raw,
        });
      }
      written += await saveMetrics(db, rows);
    }
    if (written || candidates.length) log.info({ posts: candidates.length, written }, "metrics captured");
    return written;
  }
}
