// The Web Scraper job: every TRENDS_POLL_SECONDS (and once at start, and when the desk asks), read the
// free sources once each, rank, store the run, then look up og:image for the stored articles that have
// no picture yet (once per URL, ever). Old runs are pruned after 7 days.

import { readFile } from "node:fs/promises";
import { metaImage, parseYoutubeChannels, runTrendSources, trendTagger, type PaceStore, type SourcePlan, type TextGet, type YoutubeChannel } from "@socia/core";
import {
  activeHashtagRules, knownPageImages, kvPaceStore, latestTrendRun, orgWatchKeywords, previousSourceHealth, pruneTrends, saveTrendRun, setPageImage, trendRefreshRequestedAt,
  type Db, type TrendItem, type TrendTrigger,
} from "@socia/db";
import { getText, type WebGet } from "@socia/providers";
import type { Logger } from "pino";

export interface TrendsSettings {
  pollMs: number;
  plan: SourcePlan;
  /** JSON list of YouTube channels (see parseYoutubeChannels); missing or bad: no YouTube */
  youtubeChannelsFile?: string;
  /** Article pages read for og:image per run, at most */
  ogMaxPerRun: number;
}

/** Google News article links are redirects through Google; their pages are not read for images. */
const NO_PAGE_READ = /^https:\/\/news\.google\.com\//;
const PAGE_MAX_BYTES = 1024 * 1024;

export class TrendsJob {
  private lastRunAt = 0;
  private started = false;

  constructor(
    private readonly deps: { db: Db; orgId: string; get: WebGet; settings: TrendsSettings; log: Logger; now?: () => Date; pace?: PaceStore },
  ) {
    this.pace = deps.pace ?? kvPaceStore(deps.db);
  }

  private readonly pace: PaceStore;

  /** Read on every run, so the list can be edited while the worker runs */
  private async youtubeChannels(): Promise<YoutubeChannel[]> {
    const file = this.deps.settings.youtubeChannelsFile;
    if (!file) return this.deps.settings.plan.youtube ?? [];
    try {
      return parseYoutubeChannels(JSON.parse(await readFile(file, "utf8")));
    } catch (err) {
      this.deps.log.warn({ err: String((err as Error)?.message ?? err), file }, "trends: YouTube channel list unreadable; no YouTube this run");
      return [];
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // GDELT can take 10+ s even to refuse; everything else answers in a second or two
  private text: TextGet = (url) => getText(this.deps.get, url, { timeoutMs: url.includes("gdeltproject.org") ? 30_000 : 20_000, maxBytes: 5 * 1024 * 1024, accept: "application/rss+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5" });

  /** Called every few seconds: runs at start, when due, or when the desk asked since the last run. */
  async tick(): Promise<boolean> {
    const { db, orgId, settings } = this.deps;
    const now = this.now().getTime();
    let trigger: TrendTrigger | null = null;
    if (!this.started) {
      this.started = true;
      const last = await latestTrendRun(db, orgId);
      this.lastRunAt = last?.finishedAt?.getTime() ?? 0;
      trigger = "startup";
    } else if (now - this.lastRunAt >= settings.pollMs) {
      trigger = "schedule";
    } else {
      const asked = await trendRefreshRequestedAt(db, orgId);
      if (asked && asked.getTime() > this.lastRunAt) trigger = "manual";
    }
    if (!trigger) return false;
    await this.run(trigger);
    return false;
  }

  async run(trigger: TrendTrigger): Promise<{ runId: string; items: number }> {
    const { db, orgId, settings, log } = this.deps;
    const startedAt = this.now();
    this.lastRunAt = startedAt.getTime();
    const tagger = trendTagger(await activeHashtagRules(db, orgId));
    const previous = await previousSourceHealth(db, orgId);
    const plan = { ...settings.plan, youtube: await this.youtubeChannels() };
    // Stories matching anyone's watched keywords are kept even past the pool size
    const watch = await orgWatchKeywords(db, orgId);
    const { rows, health, alerts } = await runTrendSources(this.text, plan, tagger, startedAt, this.pace, previous, watch);
    const { run, items } = await saveTrendRun(db, orgId, { trigger, startedAt, sources: health, alerts }, rows);
    this.lastRunAt = this.now().getTime();
    log.info({ trigger, runId: run.id, items: items.length, sources: health.map((h) => `${h.name}:${h.ok ? h.items : `x ${h.lastError}`}`) }, "trends run stored");
    const pages = await this.pageImages(run.id, items).catch((err) => {
      log.warn({ err }, "trends: og:image lookups stopped");
      return 0;
    });
    const pruned = await pruneTrends(db, orgId);
    if (pages || pruned) log.info({ pages, pruned }, "trends: pictures looked up, old runs pruned");
    return { runId: run.id, items: items.length };
  }

  /** og:image for stored items without a picture: each article page is read once, ever. */
  async pageImages(runId: string, items: TrendItem[]): Promise<number> {
    const { db, get, settings } = this.deps;
    const need = new Map<string, string>();
    for (const i of items) if (!i.imageUrl && !i.ogChecked && !NO_PAGE_READ.test(i.url) && !need.has(i.url)) need.set(i.url, i.sourceName);
    if (!need.size) return 0;
    const known = await knownPageImages(db, [...need.keys()]);
    let read = 0;
    for (const [url, sourceName] of need) {
      const cached = known.get(url);
      if (cached) {
        await setPageImage(db, runId, url, cached.imageUrl, cached.imageSource);
        continue;
      }
      if (read >= settings.ogMaxPerRun) continue;
      read++;
      let image: string | null = null;
      try {
        const res = await get(url, { timeoutMs: 10_000, maxBytes: PAGE_MAX_BYTES, accept: "text/html", truncate: true });
        if (res.status === 200 && /html/i.test(res.contentType)) image = metaImage(res.body.toString("utf8"), res.url);
      } catch {
        // Too slow or refused: no picture for this one, and it is not asked again
      }
      await setPageImage(db, runId, url, image, image ? sourceName : null);
    }
    return read;
  }
}
