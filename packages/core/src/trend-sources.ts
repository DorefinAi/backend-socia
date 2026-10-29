// Which free sources a Web Scraper run reads, and how politely. The fetching itself is passed in (the
// worker and API use a polite HTTPS client, tests use recorded fixtures), and so is the pacing store
// (the db kv table, shared by the worker and the API: one IP, one allowance per source), so this file
// stays free of I/O.

import {
  TREND_WINDOWS, alertLevel, buildTrends, gdeltVolume, isRajasthanAlert, parseAtom, parseCap, parseGdeltTimeline, parseGoogleTrends, parseRss,
  parseSachetRss, parseWikiTop, type RawArticle, type RawTopic, type TrendAlert, type TrendRow, type TrendTagger, type VolumePoint,
} from "./trends";

/** Sent with every Web Scraper request, so the sources can see who is asking (TRENDS_USER_AGENT overrides it) */
export const TRENDS_USER_AGENT = "SociaTrends/0.1 (First India newsroom desk; free public feeds only)";

// ─── Where ───────────────────────────────────────────────────────────────────

export const GOOGLE_NEWS_EDITIONS = {
  hi: { hl: "hi", gl: "IN", ceid: "IN:hi" },
  en: { hl: "en-IN", gl: "IN", ceid: "IN:en" },
} as const;

export function googleNewsSearchUrl(q: string, edition: keyof typeof GOOGLE_NEWS_EDITIONS): string {
  const e = GOOGLE_NEWS_EDITIONS[edition];
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${e.hl}&gl=${e.gl}&ceid=${encodeURIComponent(e.ceid)}`;
}

/** Google News India top stories, Hindi edition */
export const GOOGLE_NEWS_TOP_HI = "https://news.google.com/rss?hl=hi&gl=IN&ceid=IN:hi";

export function bingNewsUrl(q: string): string {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`;
}

export function googleTrendsUrl(geo: string): string {
  return `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
}

/** GDELT DOC 2.0, article counts over time */
export function gdeltTimelineUrl(q: string, timespan = "7d"): string {
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=timelinevolraw&format=json&timespan=${timespan}`;
}

/** Hindi Wikipedia's most-read pages for one day (Wikimedia REST, no key) */
export function wikiTopUrl(day: Date): string {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, "0");
  const d = String(day.getUTCDate()).padStart(2, "0");
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/hi.wikipedia/all-access/${y}/${m}/${d}`;
}

export function redditUrl(subreddit: string): string {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/.rss`;
}

export function youtubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

/** PIB press releases. Lang=1 and Lang=2 returned the same (Hindi) feed on 28 Oct 2026, so one request. */
export const PIB_URL = "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=2&Regid=3";
export const SACHET_URL = "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml";

export interface FeedConfig {
  name: string;
  url: string;
  /** A Rajasthan feed (counts toward Rajasthan relevance); false for national feeds */
  rajasthan: boolean;
}

/** Publisher feeds that answered on 28 Oct 2026 (Patrika, First India, NDTV Rajasthan, Jagran, Live Hindustan and Zee did not) */
export const DEFAULT_FEEDS: FeedConfig[] = [
  { name: "Dainik Bhaskar", url: "https://www.bhaskar.com/rss-v1--category-1740.xml", rajasthan: true },
  { name: "Amar Ujala", url: "https://www.amarujala.com/rss/rajasthan.xml", rajasthan: true },
  { name: "Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/3012544.cms", rajasthan: true },
  { name: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/cities/jaipur-news/rssfeed.xml", rajasthan: true },
  { name: "Indian Express", url: "https://indianexpress.com/section/cities/jaipur/feed/", rajasthan: true },
  { name: "NDTV India", url: "https://feeds.feedburner.com/ndtvkhabar-latest", rajasthan: false },
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", rajasthan: false },
];

/** "Name|https://…,Name|https://…|national" (TRENDS_RSS_FEEDS); bad entries are skipped */
export function parseFeedList(value: string | undefined): FeedConfig[] {
  if (!value?.trim()) return DEFAULT_FEEDS;
  return value
    .split(",")
    .map((part) => {
      const [name, url, scope] = part.split("|").map((s) => s.trim());
      return name && url && /^https:\/\//.test(url) ? { name, url, rajasthan: scope !== "national" } : null;
    })
    .filter((f): f is FeedConfig => !!f);
}

export interface YoutubeChannel {
  name: string;
  channelId: string;
}

/** The channel list file: an array, or { channels: [...] }; id as channelId / channel_id / id, name as name / title */
export function parseYoutubeChannels(json: unknown): YoutubeChannel[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as { channels?: unknown })?.channels) ? (json as { channels: unknown[] }).channels : [];
  const out: YoutubeChannel[] = [];
  for (const raw of list) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const channelId = String(c.channelId ?? c.channel_id ?? c.id ?? "").trim();
    const name = String(c.name ?? c.title ?? channelId).trim();
    if (/^UC[\w-]{22}$/.test(channelId) && !out.some((o) => o.channelId === channelId)) out.push({ name, channelId });
  }
  return out;
}

export interface SourcePlan {
  /** Google News search text per edition, e.g. { hi: "राजस्थान", en: "Rajasthan" } */
  googleNews: { hi: string; en: string };
  /** Google News India top stories (Hindi) */
  googleNewsTop?: boolean;
  /** Bing News search text; "" or absent skips Bing */
  bing?: string;
  feeds: FeedConfig[];
  government?: { pib: boolean; sachet: boolean };
  /** Google Trends country, e.g. "IN"; "" skips Google Trends */
  geo: string;
  gdelt: boolean;
  /** Subreddit; "" or absent skips Reddit */
  reddit?: string;
  wikipedia?: boolean;
  youtube?: YoutubeChannel[];
}

/** A GET that returns the body text of a 200, or throws with a short reason */
export type TextGet = (url: string) => Promise<string>;

// ─── Health ──────────────────────────────────────────────────────────────────

export const SOURCE_GROUPS = ["News", "Publisher RSS", "Government", "Trends", "Volume", "Social", "YouTube"] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];

/** How one source did in a run, as the desk shows it */
export interface SourceHealth {
  name: string;
  group: SourceGroup;
  ok: boolean;
  /** When the data shown was fetched (an hourly or daily source reuses its last fetch in between) */
  at: string;
  /** Items taken from it (same as itemsLastRun; kept for the first desk build) */
  items: number;
  itemsLastRun: number;
  /** The last time the source answered, this run or an earlier one; null if never */
  lastSuccessAt: string | null;
  /** Why it failed, in plain words; absent when ok */
  lastError?: string;
}

/** An error whose message is already fit for the desk */
export class SourceError extends Error {}

/** Any failure as one short sentence an editor can read */
export function plainError(err: unknown): string {
  if (err instanceof SourceError) return err.message;
  const m = String((err as Error)?.message ?? err);
  if (/HTTP 429|rate limit|limit requests/i.test(m)) return "Too many requests: the source asked us to slow down. Trying again later.";
  if (/timed out|timeout|aborted/i.test(m)) return "No answer in time. Trying again next run.";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "Could not find the source's address (DNS). Trying again next run.";
  if (/ECONNRESET|ECONNREFUSED|socket|fetch failed|other side closed/i.test(m)) return "The connection was dropped by the source. Trying again next run.";
  if (/certificate|TLS|SSL/i.test(m)) return "Secure connection failed (certificate). Trying again next run.";
  const status = /HTTP (\d{3})/.exec(m)?.[1];
  if (status) return `The source answered with an error (HTTP ${status}).`;
  if (/JSON|Unexpected token|not a feed/i.test(m)) return "The answer was not in the expected format.";
  if (/private address|Only https|Local hosts/i.test(m)) return "This address is not allowed.";
  return `Failed: ${m.slice(0, 120)}`;
}

class Health {
  readonly list: SourceHealth[] = [];
  constructor(private readonly previous: SourceHealth[], private readonly now: () => Date) {}

  /** Runs one source; a failure is recorded and gives nothing. `at` overrides the time for a reused answer. */
  async run<T>(name: string, group: SourceGroup, fn: () => Promise<T[] | { items: T[]; at: Date }>): Promise<T[]> {
    try {
      const r = await fn();
      const items = Array.isArray(r) ? r : r.items;
      const at = (Array.isArray(r) ? this.now() : r.at).toISOString();
      this.list.push({ name, group, ok: true, at, items: items.length, itemsLastRun: items.length, lastSuccessAt: at });
      return items;
    } catch (err) {
      this.list.push({
        name, group, ok: false, at: this.now().toISOString(), items: 0, itemsLastRun: 0,
        lastSuccessAt: this.previous.find((p) => p.name === name)?.lastSuccessAt ?? null, lastError: plainError(err),
      });
      return [];
    }
  }
}

// ─── Pacing ──────────────────────────────────────────────────────────────────
// GDELT allows about one request per 5 s per IP (12 s kept here); over that it answers HTTP 429 with a plain-text note
// (often after 10+ s) and keeps throttling for a while, or drops the connection. Reddit wants to be read
// rarely; the Wikipedia list changes once a day. So each paced source has a minimum gap between calls,
// a back-off after a refusal (doubling to a cap), and, for the slow ones, the last answer kept and
// reused until the next fetch is due.

export interface PaceState {
  lastAt: number;
  backoffUntil: number;
  failures: number;
  /** The last good answer, for sources that are read rarely */
  cachedAt?: number;
  cache?: unknown;
}

export interface PaceStore {
  load(key: string): Promise<PaceState>;
  save(key: string, state: PaceState): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PaceRule {
  label: string;
  minGapMs: number;
  /** Wait this long at most for the next free slot; longer: skip (or reuse the last answer) */
  waitMaxMs: number;
  backoffMs: number;
  backoffMaxMs: number;
  /** Keep the last answer and reuse it until minGapMs has passed */
  cache: boolean;
  rateNote: string;
}

export const PACE = {
  // GDELT documents 5 s; on 28 Oct 2026 a second call 6 s after a slow answer still got 429, so 12 s
  gdelt: { label: "GDELT", minGapMs: 12_000, waitMaxMs: 25_000, backoffMs: 120_000, backoffMaxMs: 30 * 60_000, cache: false, rateNote: "GDELT allows about one every 5 seconds." },
  reddit: { label: "Reddit", minGapMs: 3600_000, waitMaxMs: 0, backoffMs: 3600_000, backoffMaxMs: 6 * 3600_000, cache: true, rateNote: "Reddit asks for few requests." },
  wikipedia: { label: "Wikipedia", minGapMs: 6 * 3600_000, waitMaxMs: 0, backoffMs: 3600_000, backoffMaxMs: 6 * 3600_000, cache: true, rateNote: "the daily list is read a few times a day." },
} satisfies Record<string, PaceRule>;

export const GDELT_MIN_GAP_MS = PACE.gdelt.minGapMs;
/** Between YouTube channel feeds: at most one request a second */
export const YOUTUBE_GAP_MS = 1000;

/** In-memory store, for tests and single-process use */
export function memoryPaceStore(clock: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const states = new Map<string, PaceState>();
  return {
    states,
    load: async (key: string) => ({ ...(states.get(key) ?? { lastAt: 0, backoffUntil: 0, failures: 0 }) }),
    save: async (key: string, s: PaceState) => void states.set(key, { ...s }),
    sleep,
    now: clock,
  } satisfies PaceStore & { states: Map<string, PaceState> };
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const REFUSED = /HTTP 429|rate limit|limit requests|fetch failed|ECONNRESET|socket|other side closed|timed out|timeout|aborted/i;

function refusalWhy(rule: PaceRule, err: unknown): string {
  const m = String((err as Error)?.message ?? err);
  if (/HTTP 429|rate limit|limit requests/i.test(m)) return `Too many requests: ${rule.rateNote}`;
  if (/timed out|timeout|aborted/i.test(m)) return `${rule.label} did not answer in time.`;
  return `${rule.label} dropped the connection (it does this when busy or throttling).`;
}

/** Thrown inside a paced fetch when the answer itself says "slow down" (GDELT's plain-text note) */
class RateNote extends Error {
  constructor() {
    super("limit requests");
  }
}

/**
 * One call under a pace rule. Returns the fresh answer, or the kept one when the source is not due yet
 * (cached rules), or throws a SourceError in plain words (paused, skipped, refused).
 */
export async function paced<T>(store: PaceStore | null, key: string, rule: PaceRule, fetch: () => Promise<T>): Promise<{ value: T; at: Date; fresh: boolean }> {
  if (!store) return { value: await fetch(), at: new Date(), fresh: true };
  const state = await store.load(key);
  const now = store.now();
  const kept = rule.cache && state.cache !== undefined ? { value: state.cache as T, at: new Date(state.cachedAt ?? state.lastAt), fresh: false } : null;
  if (kept && now - (state.cachedAt ?? 0) < rule.minGapMs) return kept;
  if (now < state.backoffUntil) {
    if (kept) return kept;
    throw new SourceError(`Paused: ${rule.label} asked us to slow down. Next try in about ${minutes(state.backoffUntil - now)} min.`);
  }
  const wait = state.lastAt + rule.minGapMs - now;
  if (wait > 0) {
    if (wait > rule.waitMaxMs) {
      if (kept) return kept;
      throw new SourceError(`Skipped this time: another ${rule.label} request was just made.`);
    }
    await store.sleep(wait);
  }
  // Take the slot before asking, so the other process waits for it
  await store.save(key, { ...state, lastAt: store.now() });
  let value: T;
  try {
    value = await fetch();
  } catch (err) {
    if (!(err instanceof RateNote) && !REFUSED.test(String((err as Error)?.message ?? err))) {
      // The source answered (a complaint about the query is still an answer): it is not throttling us
      if (err instanceof SourceError) await store.save(key, { ...state, lastAt: store.now(), backoffUntil: 0, failures: 0 });
      throw err instanceof SourceError ? err : new SourceError(plainError(err));
    }
    const failures = state.failures + 1;
    const pause = Math.min(rule.backoffMaxMs, rule.backoffMs * 2 ** (failures - 1));
    await store.save(key, { ...state, lastAt: store.now(), backoffUntil: store.now() + pause, failures });
    throw new SourceError(`${refusalWhy(rule, err)} Pausing ${rule.label} for ${minutes(pause)} min.`);
  }
  const at = store.now();
  await store.save(key, { lastAt: at, backoffUntil: 0, failures: 0, ...(rule.cache ? { cache: value, cachedAt: at } : {}) });
  return { value, at: new Date(at), fresh: true };
}

// ─── GDELT ───────────────────────────────────────────────────────────────────

/** One GDELT timeline call under its pace rule. Plain-text answers are read: the rate note backs off, a query complaint does not. */
export async function gdeltTimeline(get: TextGet, store: PaceStore | null, q: string): Promise<VolumePoint[]> {
  const { value } = await paced(store, "gdelt", PACE.gdelt, async () => {
    const body = await get(gdeltTimelineUrl(q));
    if (!body.trimStart().startsWith("{")) {
      const text = body.trim().replace(/\s+/g, " ");
      if (/limit requests/i.test(text)) throw new RateNote();
      throw new SourceError(`GDELT did not accept the query: ${text.slice(0, 100) || "empty answer"}`);
    }
    try {
      return parseGdeltTimeline(JSON.parse(body));
    } catch {
      throw new SourceError("GDELT's answer was cut off or not valid JSON.");
    }
  });
  return value;
}

/** GDELT query words: one district (quoted when it has a space or hyphen) and Rajasthan */
export function gdeltQuery(top: Pick<TrendRow, "district"> | undefined): string {
  const d = top?.district?.replace(/[^\p{L}\p{N} -]/gu, "").trim();
  if (!d) return "Rajasthan";
  return /\s|-/.test(d) ? `"${d}" Rajasthan` : `${d} Rajasthan`;
}

/** Topics of 24 h asked about per run (topics with the same district share a call; calls 12 s apart) */
export const GDELT_TOPICS_PER_RUN = 3;

/** GDELT's article counts for the top topics of 24 h, on those topics in every window. Stops at the first refusal. */
export async function addGdeltVolume(
  get: TextGet, store: PaceStore | null, rows: TrendRow[], health: SourceHealth[], previous: SourceHealth[], now: Date, topics = GDELT_TOPICS_PER_RUN,
): Promise<void> {
  const top = rows.filter((r) => r.type === "topics" && r.window === "24h").sort((a, b) => a.rank - b.rank).slice(0, topics);
  if (!top.length) return;
  const queries = new Map<string, TrendRow[]>();
  for (const t of top) queries.set(gdeltQuery(t), [...(queries.get(gdeltQuery(t)) ?? []), t]);
  const h = new Health(previous, () => now);
  await h.run("GDELT", "Volume", async () => {
    const done: TrendRow[] = [];
    for (const [q, list] of queries) {
      let points: VolumePoint[];
      try {
        points = await gdeltTimeline(get, store, q);
      } catch (err) {
        if (done.length) break; // some counts made it; keep them and stop asking
        throw err;
      }
      for (const t of list) {
        for (const r of rows) {
          if (r.type !== "topics" || r.title !== t.title) continue;
          const v = gdeltVolume(points, TREND_WINDOWS[r.window], now);
          if (v.volume) r.volume = `${v.volume} (GDELT)`;
          r.growth = v.growth;
        }
        done.push(t);
      }
    }
    return done;
  });
  health.push(...h.list);
}

// ─── Collecting ──────────────────────────────────────────────────────────────

/** Up to this many Rajasthan alerts get their CAP file read (validity, severity) per run */
const CAP_PER_RUN = 5;

const revive = (a: RawArticle): RawArticle => ({ ...a, publishedAt: a.publishedAt ? new Date(a.publishedAt) : null });
const reviveTopic = (t: RawTopic): RawTopic => ({ ...t, publishedAt: t.publishedAt ? new Date(t.publishedAt) : null, news: t.news.map(revive) });

/** Rajasthan's disaster warnings from NDMA Sachet, with validity and severity from each CAP file */
async function sachetAlerts(get: TextGet, tagger: TrendTagger, now: Date): Promise<TrendAlert[]> {
  const items = parseSachetRss(await get(SACHET_URL)).filter(isRajasthanAlert);
  const alerts: TrendAlert[] = [];
  for (const item of items.slice(0, CAP_PER_RUN)) {
    const cap = await get(item.capUrl).then(parseCap).catch(() => null);
    // Expired warnings are not shown
    if (cap?.expires && cap.expires.getTime() < now.getTime()) continue;
    const text = cap?.headline || item.title;
    alerts.push({
      level: alertLevel(`${item.title} ${cap?.headline ?? ""}`, cap?.severity ?? ""), text, event: cap?.event ?? "", severity: cap?.severity ?? "",
      validFrom: (cap?.effective ?? item.publishedAt)?.toISOString() ?? null, validUntil: cap?.expires?.toISOString() ?? null,
      districts: tagger.districts(`${item.title} ${cap?.headline ?? ""} ${cap?.area ?? ""}`), issuer: item.issuer, url: item.capUrl, source: "NDMA Sachet",
    });
  }
  return alerts;
}

export interface Collected {
  articles: RawArticle[];
  topics: RawTopic[];
  alerts: TrendAlert[];
  health: SourceHealth[];
}

/** One request to each source (the paced ones only when due), in turn; a failed source is recorded and skipped. */
export async function collectSources(
  get: TextGet, plan: SourcePlan, now: () => Date = () => new Date(), previous: SourceHealth[] = [], store: PaceStore | null = null, tagger?: TrendTagger,
): Promise<Collected> {
  const h = new Health(previous, now);
  const articles: RawArticle[] = [];
  const news = { name: "Google News", platform: "Google News" as const };
  for (const edition of ["hi", "en"] as const) {
    const q = plan.googleNews[edition];
    if (q) articles.push(...(await h.run(`Google News (${edition})`, "News", async () => parseRss(await get(googleNewsSearchUrl(q, edition)), { ...news, rajasthan: true }))));
  }
  if (plan.googleNewsTop) articles.push(...(await h.run("Google News top stories", "News", async () => parseRss(await get(GOOGLE_NEWS_TOP_HI), { ...news, rajasthan: false }))));
  const bing = plan.bing;
  if (bing) articles.push(...(await h.run("Bing News", "News", async () => parseRss(await get(bingNewsUrl(bing)), { name: "Bing News", platform: "Bing News", rajasthan: true }))));
  for (const feed of plan.feeds) {
    articles.push(...(await h.run(feed.name, "Publisher RSS", async () => parseRss(await get(feed.url), { name: feed.name, platform: "RSS", rajasthan: feed.rajasthan }))));
  }
  if (plan.government?.pib) articles.push(...(await h.run("PIB", "Government", async () => parseRss(await get(PIB_URL), { name: "PIB", platform: "Government", rajasthan: false }))));
  const alerts = plan.government?.sachet && tagger ? await h.run("NDMA Sachet", "Government", () => sachetAlerts(get, tagger, now())) : [];

  const topics: RawTopic[] = [];
  if (plan.geo) topics.push(...(await h.run("Google Trends", "Trends", async () => parseGoogleTrends(await get(googleTrendsUrl(plan.geo))))));
  if (plan.wikipedia) {
    topics.push(...(await h.run("Hindi Wikipedia", "Trends", async () => {
      const day = new Date(now().getTime() - 86400_000);
      const r = await paced(store, "wikipedia", PACE.wikipedia, async () => parseWikiTop(JSON.parse(await get(wikiTopUrl(day))), day));
      return { items: r.value.map(reviveTopic), at: r.at };
    })));
  }
  const sub = plan.reddit;
  if (sub) {
    articles.push(...(await h.run(`Reddit r/${sub}`, "Social", async () => {
      const r = await paced(store, `reddit.${sub}`, PACE.reddit, async () => parseAtom(await get(redditUrl(sub)), { name: `Reddit r/${sub}`, platform: "Reddit", rajasthan: true }));
      return { items: r.value.map(revive), at: r.at };
    })));
  }
  const channels = plan.youtube ?? [];
  if (channels.length) {
    articles.push(...(await h.run("YouTube", "YouTube", async () => {
      const videos: RawArticle[] = [];
      let failed = 0;
      let firstError: unknown = null;
      for (const [i, c] of channels.entries()) {
        if (i && store) await store.sleep(YOUTUBE_GAP_MS);
        try {
          videos.push(...parseAtom(await get(youtubeFeedUrl(c.channelId)), { name: c.name, platform: "YouTube", rajasthan: true }));
        } catch (err) {
          failed++;
          firstError ??= err;
        }
      }
      // Some channels answering is a working source; every channel failing is not
      if (failed === channels.length) throw firstError;
      return videos;
    })));
  }
  return { articles, topics, alerts, health: h.list };
}

/** A full run: sources, grouping and ranking, alerts on matching items, GDELT volume for the top topics. */
export async function runTrendSources(
  get: TextGet, plan: SourcePlan, tagger: TrendTagger, now: Date, store: PaceStore | null, previous: SourceHealth[] = [],
): Promise<{ rows: TrendRow[]; health: SourceHealth[]; alerts: TrendAlert[] }> {
  const { articles, topics, alerts, health } = await collectSources(get, plan, () => now, previous, store, tagger);
  const rows = buildTrends({ articles, topics, alerts }, tagger, now);
  if (plan.gdelt) await addGdeltVolume(get, store, rows, health, previous, now);
  return { rows, health, alerts };
}

/** The desk's live search: Google News (both editions) and Bing News for the text, plus GDELT's count for it. Articles, 7 d. */
export async function searchTrendSources(
  get: TextGet, q: string, tagger: TrendTagger, now: Date, store: PaceStore | null, previous: SourceHealth[] = [], gdelt = true,
): Promise<{ rows: TrendRow[]; health: SourceHealth[] }> {
  const { articles, health } = await collectSources(get, { googleNews: { hi: q, en: q }, bing: q, feeds: [], geo: "", gdelt: false }, () => now, previous);
  const rows = buildTrends({ articles, topics: [] }, tagger, now).filter((r) => r.type === "articles" && r.window === "7d");
  if (gdelt && store) {
    const h = new Health(previous, () => now);
    await h.run("GDELT", "Volume", async () => {
      const points = await gdeltTimeline(get, store, q);
      const v = gdeltVolume(points, 24, now);
      for (const r of rows) {
        if (v.volume) r.volume = `${v.volume} in 24h (GDELT)`;
        r.growth = v.growth;
      }
      return points;
    });
    health.push(...h.list);
  }
  return { rows, health };
}
