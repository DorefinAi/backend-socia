// Web trends from free public sources, by rules only (no AI): parse the feeds, drop duplicates, group
// articles into topics, tag each with a Rajasthan district and a fixed super tag, rank Rajasthan first,
// and derive hashtags. Pure functions: the worker fetches, this file decides. Contract:
// handoff/web-scraper-contract.md.

import { fold } from "./fold";
import { Gazetteer, type GazetteerEntry } from "./gazetteer";
import { asHashtag, type HashtagRule } from "./hashtags";
import { RAJASTHAN_DISTRICTS } from "./rajasthan";

export const TREND_TYPES = ["topics", "articles", "hashtags"] as const;
export type TrendType = (typeof TREND_TYPES)[number];
export const TREND_WINDOWS = { "12h": 12, "24h": 24, "7d": 168 } as const;
export type TrendWindow = keyof typeof TREND_WINDOWS;
export const TREND_PLATFORMS = ["Google News", "Google Trends", "GDELT", "RSS", "YouTube", "Bing News", "Wikipedia", "Reddit", "Government"] as const;
export type TrendPlatform = (typeof TREND_PLATFORMS)[number];
/** Kept per type per window */
export const TREND_TOP = 20;

export const SUPER_TAGS = [
  "Politics", "Crime", "Weather", "Infrastructure", "Education", "Health", "Agriculture", "Culture & Tourism", "Sports", "Business",
] as const;
/** When no keyword of the map matched */
export const GENERAL_TAG = "General";

/** Fixed keyword map, Hindi and English, checked in this order (the first tag with a hit wins ties). */
const SUPER_TAG_WORDS: Record<(typeof SUPER_TAGS)[number], string[]> = {
  Politics: ["चुनाव", "मतदान", "सरकार", "मुख्यमंत्री", "मंत्री", "विधानसभा", "भाजपा", "कांग्रेस", "पंचायत", "निकाय", "सांसद", "विधायक", "election", "chunav", "minister", "cm", "bjp", "congress", "assembly", "government", "panchayat", "mla", "mp", "poll", "polls", "vote", "voting", "hearing", "court", "high court", "हाईकोर्ट", "कोर्ट", "supreme court"],
  Crime: ["पुलिस", "चोरी", "हत्या", "लूट", "गिरफ्तार", "अपराध", "ठगी", "रिश्वत", "एसीबी", "हादसा", "दुर्घटना", "police", "murder", "arrested", "arrest", "crime", "theft", "robbery", "fraud", "acb", "bribe", "accident", "killed", "dead", "death"],
  Weather: ["मौसम", "बारिश", "मानसून", "ठंड", "गर्मी", "ओलावृष्टि", "तापमान", "कोहरा", "weather", "rain", "monsoon", "heatwave", "cold", "temperature", "fog", "imd"],
  Infrastructure: ["मेट्रो", "सड़क", "हाईवे", "पुल", "रेल", "रेलवे", "एयरपोर्ट", "बिजली", "पानी", "पेयजल", "metro", "road", "highway", "bridge", "rail", "railway", "airport", "flight", "power", "water", "township", "infrastructure"],
  Education: ["शिक्षा", "स्कूल", "कॉलेज", "विश्वविद्यालय", "परीक्षा", "भर्ती", "रिजल्ट", "छात्र", "कोचिंग", "school", "college", "university", "exam", "recruitment", "result", "students", "student", "coaching", "neet", "reet", "rpsc", "rsmssb"],
  Health: ["स्वास्थ्य", "अस्पताल", "डॉक्टर", "डेंगू", "बीमारी", "इलाज", "health", "hospital", "doctor", "dengue", "disease", "aiims", "sms hospital", "pollution", "प्रदूषण"],
  Agriculture: ["किसान", "फसल", "मंडी", "खेती", "खाद", "बीज", "गेहूं", "सरसों", "मक्का", "धान", "farmer", "farmers", "crop", "crops", "mandi", "agriculture", "fertiliser", "fertilizer", "msp"],
  "Culture & Tourism": ["मेला", "पर्यटन", "पर्यटक", "त्योहार", "उत्सव", "मंदिर", "दिवाली", "करवा", "किला", "fair", "tourism", "tourist", "tourists", "festival", "temple", "diwali", "fort", "heritage", "culture"],
  Sports: ["क्रिकेट", "खिलाड़ी", "मैच", "खेल", "ओलंपिक", "cricket", "match", "player", "sports", "ipl", "olympic", "kabaddi", "football", "hockey"],
  Business: ["उद्योग", "कारोबार", "निवेश", "बाजार", "व्यापार", "शेयर", "industry", "business", "investment", "investor", "market", "trade", "shares", "sebi", "startup", "economy", "gdp", "riico"],
};

const RAJASTHAN_WORDS = new Set(["राजस्थान", "rajasthan", "राजस्थानी"]);

const STOPWORDS = new Set([
  "के", "का", "की", "को", "में", "से", "पर", "ने", "और", "है", "हैं", "था", "थी", "थे", "भी", "तो", "यह", "वह", "एक", "लिए", "कर", "करने", "किया", "गया", "गई", "हुआ", "हुई", "जा", "रहा", "रही", "रहे", "अब", "नहीं", "साथ", "बाद", "तक", "लेकर", "बड़ा", "बड़ी", "जानें",
  "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "is", "are", "was", "be", "by", "with", "at", "as", "from", "its", "it", "after", "over", "new", "news", "latest", "today", "live", "updates", "says", "said",
]);

// ─── Parsing ────────────────────────────────────────────────────────────────

export interface RawArticle {
  title: string;
  url: string;
  /** Publisher, e.g. "Dainik Bhaskar" */
  sourceName: string;
  platform: TrendPlatform;
  publishedAt: Date | null;
  description: string;
  imageUrl: string | null;
  imageSource: string | null;
  /** From a Rajasthan-only feed or query: counts toward Rajasthan relevance */
  rajasthanFeed: boolean;
}

export interface RawTopic {
  /** The search people made ("investor"), or a most-read Wikipedia page */
  title: string;
  platform: "Google Trends" | "Wikipedia";
  /** Where the topic itself lives (the Wikipedia page); Google Trends topics link to their first news item */
  url: string | null;
  /** "200+ searches", "2.1K views" */
  volume: string;
  /** "200+" as Google Trends gives it */
  traffic: string;
  trafficCount: number | null;
  publishedAt: Date | null;
  imageUrl: string | null;
  imageSource: string | null;
  news: RawArticle[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const stripTags = (s: string) => s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ");
/**
 * Feed text as plain text: CDATA unwrapped, entities decoded, tags dropped, and decoded again (many feeds
 * send HTML entity-encoded inside the element), spaces collapsed. Never any markup in what the desk shows.
 */
export function cleanText(s: string): string {
  return decodeEntities(stripTags(decodeEntities(stripTags(unCdata(s))))).replace(/[<>]/g, " ").replace(/\s+/gu, " ").trim();
}

/** Plain text cut to at most `max` characters on a word boundary, with "…" when cut */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/u, "")}…`;
}

function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

function rawTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  return re.exec(block)?.[1] ?? null;
}

function tagText(block: string, tag: string): string {
  const raw = rawTag(block, tag);
  return raw === null ? "" : cleanText(raw);
}

function attrOf(block: string, tag: string, attr: string, where?: (el: string) => boolean): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "g");
  for (const m of block.matchAll(re)) {
    if (where && !where(m[0])) continue;
    const a = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(m[0]);
    if (a) return decodeEntities(a[2] ?? a[3] ?? "");
  }
  return null;
}

/** Only absolute https links leave the parser */
export function httpsUrl(value: string | null | undefined, base?: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim(), base);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function date(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const IMAGE_TYPE = /^image\/(jpeg|jpg|png|webp)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)(?:[?#].*)?$/i;

/** The item's own picture: media:content, media:thumbnail, an image enclosure, or an <img> in the description. GIFs are skipped. */
function itemImage(block: string): string | null {
  const okType = (el: string) => {
    const type = /\btype\s*=\s*["']([^"']*)["']/.exec(el)?.[1];
    const medium = /\bmedium\s*=\s*["']([^"']*)["']/.exec(el)?.[1];
    if (type) return IMAGE_TYPE.test(type);
    if (medium) return medium === "image";
    return true;
  };
  const candidates = [
    attrOf(block, "media:content", "url", okType),
    attrOf(block, "media:thumbnail", "url"),
    attrOf(block, "enclosure", "url", okType),
    /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(unCdata(rawTag(block, "description") ?? ""))?.[1] ?? null,
  ];
  for (const c of candidates) {
    const url = httpsUrl(c ? decodeEntities(c) : null);
    if (url && !/\.gif(?:[?#].*)?$/i.test(url)) return url;
  }
  return null;
}

/** Bing News links go through bing.com/news/apiclick.aspx?…&url=<article>: take the article itself (no request needed) */
export function unwrapRedirect(link: string): string {
  try {
    const u = new URL(link.replace(/^http:\/\/www\.bing\.com\//, "https://www.bing.com/"));
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.searchParams.get("url")) return u.searchParams.get("url")!;
  } catch {
    // not a URL
  }
  return link;
}

/**
 * Any RSS 2.0 feed. Google News items carry the publisher in <source> and in a " - Publisher" title
 * suffix; both are used. Items without an https link are dropped.
 */
export function parseRss(xml: string, feed: { name: string; platform: TrendPlatform; rajasthan: boolean }): RawArticle[] {
  const out: RawArticle[] = [];
  for (const block of blocks(xml, "item")) {
    let title = tagText(block, "title");
    const link = tagText(block, "link");
    const guid = tagText(block, "guid");
    const url = httpsUrl(unwrapRedirect(link)) ?? httpsUrl(unwrapRedirect(guid));
    if (!title || !url) continue;
    const source = tagText(block, "source") || tagText(block, "News:Source").replace(/ on MSN$/, "");
    let sourceName = feed.name;
    if (source) {
      sourceName = source;
      const suffix = ` - ${source}`;
      if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    }
    const description = feed.platform === "Google News" ? "" : cutText(tagText(block, "description"), 600);
    const imageUrl = itemImage(block) ?? httpsUrl(tagText(block, "News:Image") || null);
    out.push({
      title, url, sourceName, platform: feed.platform, publishedAt: date(tagText(block, "pubDate")), description,
      imageUrl, imageSource: imageUrl ? sourceName : null, rajasthanFeed: feed.rajasthan,
    });
  }
  return out;
}

/** "200+" → 200, "2K+" → 2000, "1M+" → 1000000 */
export function trafficCount(traffic: string): number | null {
  const m = /^([\d.,]+)\s*([KkMmLl]?)\+?$/.exec(traffic.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  const mult = { k: 1e3, m: 1e6, l: 1e5 }[m[2]!.toLowerCase()] ?? 1;
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

/** Google Trends "trending now" RSS (trends.google.com/trending/rss?geo=IN) */
export function parseGoogleTrends(xml: string): RawTopic[] {
  return blocks(xml, "item").map((block) => {
    const picture = httpsUrl(tagText(block, "ht:picture"));
    const traffic = tagText(block, "ht:approx_traffic");
    const news = blocks(block, "ht:news_item")
      .map((n): RawArticle | null => {
        const url = httpsUrl(tagText(n, "ht:news_item_url"));
        const title = tagText(n, "ht:news_item_title");
        if (!url || !title) return null;
        const source = tagText(n, "ht:news_item_source") || "Google Trends";
        const img = httpsUrl(tagText(n, "ht:news_item_picture"));
        return {
          title, url, sourceName: source, platform: "Google Trends", publishedAt: date(tagText(block, "pubDate")),
          description: tagText(n, "ht:news_item_snippet"), imageUrl: img, imageSource: img ? source : null, rajasthanFeed: false,
        };
      })
      .filter((n): n is RawArticle => !!n);
    return {
      title: tagText(block, "title"), platform: "Google Trends" as const, url: null, volume: traffic ? `${traffic} searches` : "",
      traffic, trafficCount: trafficCount(traffic), publishedAt: date(tagText(block, "pubDate")),
      imageUrl: picture, imageSource: picture ? tagText(block, "ht:picture_source") || null : null, news,
    };
  }).filter((t) => t.title);
}

function atomLink(block: string): string | null {
  return attrOf(block, "link", "href", (el) => !/\brel\s*=\s*["'](?!alternate)/.test(el));
}

/**
 * Atom feeds: Reddit's subreddit feed and YouTube's channel feed (no key). YouTube's thumbnail is in
 * media:group/media:thumbnail; Reddit's preview picture is an <img> in the entry's HTML content.
 */
export function parseAtom(xml: string, feed: { name: string; platform: TrendPlatform; rajasthan: boolean }): RawArticle[] {
  const out: RawArticle[] = [];
  const channel = tagText(rawTag(xml, "author") ?? "", "name");
  for (const block of blocks(xml, "entry")) {
    const title = tagText(block, "title");
    const url = httpsUrl(atomLink(block));
    if (!title || !url) continue;
    const content = decodeEntities(unCdata(rawTag(block, "content") ?? ""));
    const img = attrOf(block, "media:thumbnail", "url") ?? /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(content)?.[1] ?? null;
    const imageUrl = httpsUrl(img ? decodeEntities(img) : null);
    const description = feed.platform === "YouTube" ? cutText(tagText(block, "media:description"), 600) : "";
    const sourceName = feed.platform === "YouTube" ? tagText(block, "name") || channel || feed.name : feed.name;
    out.push({
      title, url, sourceName, platform: feed.platform, publishedAt: date(tagText(block, "published") || tagText(block, "updated")), description,
      imageUrl: imageUrl && !/\.gif(?:[?#].*)?$/i.test(imageUrl) ? imageUrl : null, imageSource: imageUrl ? sourceName : null, rajasthanFeed: feed.rajasthan,
    });
  }
  return out;
}

/** Wikimedia REST "top" pages for a day; the main page, special pages and other namespaces are left out. */
export function parseWikiTop(json: unknown, day: Date, max = 50): RawTopic[] {
  const articles = (json as { items?: { articles?: { article?: string; views?: number }[] }[] })?.items?.[0]?.articles;
  if (!Array.isArray(articles)) return [];
  const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59, 59));
  return articles
    .filter((a) => typeof a.article === "string" && typeof a.views === "number")
    .filter((a) => a.article !== "मुखपृष्ठ" && a.article !== "-" && !a.article!.includes(":"))
    .slice(0, max)
    .map((a) => ({
      title: a.article!.replace(/_/g, " "), platform: "Wikipedia" as const, url: `https://hi.wikipedia.org/wiki/${encodeURIComponent(a.article!)}`,
      volume: `${compact(a.views!)} views`, traffic: "", trafficCount: a.views!, publishedAt: end, imageUrl: null, imageSource: null, news: [],
    }));
}

export interface VolumePoint {
  at: Date;
  value: number;
}

/** GDELT DOC API, mode=timelinevolraw, format=json: the article counts over time. */
export function parseGdeltTimeline(json: unknown): VolumePoint[] {
  const timeline = (json as { timeline?: { data?: { date?: string; value?: number }[] }[] })?.timeline;
  const data = Array.isArray(timeline) ? timeline[0]?.data : null;
  if (!Array.isArray(data)) return [];
  const out: VolumePoint[] = [];
  for (const p of data) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(p?.date ?? "");
    if (!m || typeof p.value !== "number") continue;
    out.push({ at: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)), value: p.value });
  }
  return out;
}

export interface Volume {
  /** "1.2K articles" */
  volume: string;
  /** "+180% in 6h", or "" when there is nothing to compare with */
  growth: string;
}

/** Articles in the window, and growth of the last 6 h over the 6 h before (GDELT counts). */
export function gdeltVolume(points: VolumePoint[], windowHours: number, now: Date): Volume {
  const since = (h: number) => now.getTime() - h * 3600_000;
  const sum = (from: number, to: number) => points.filter((p) => p.at.getTime() > from && p.at.getTime() <= to).reduce((a, p) => a + p.value, 0);
  const total = sum(since(windowHours), now.getTime());
  const last = sum(since(6), now.getTime());
  const before = sum(since(12), since(6));
  const growth = before > 0 ? `${last >= before ? "+" : "−"}${Math.round((Math.abs(last - before) / before) * 100)}% in 6h` : "";
  return { volume: total > 0 ? `${compact(total)} articles` : "", growth };
}

/** 1234 → "1.2K", 2500000 → "2.5M" */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** og:image (or twitter:image) from an article page's <head>, as an absolute https URL. */
export function metaImage(html: string, pageUrl: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const el = m[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(el)?.[1]?.toLowerCase();
    if (key !== "og:image" && key !== "og:image:secure_url" && key !== "twitter:image" && key !== "twitter:image:src") continue;
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(el)?.[1];
    const url = httpsUrl(content ? decodeEntities(content) : null, pageUrl);
    if (url && !/\.gif(?:[?#].*)?$/i.test(url)) return url;
  }
  return null;
}

// ─── Disaster alerts (NDMA Sachet, CAP) ──────────────────────────────────────

export interface SachetItem {
  title: string;
  /** The CAP file with severity and validity */
  capUrl: string;
  /** Who issued it, e.g. "IMD Jaipur" */
  issuer: string;
  publishedAt: Date | null;
}

export function parseSachetRss(xml: string): SachetItem[] {
  return blocks(xml, "item")
    .map((b) => ({
      title: tagText(b, "title"),
      capUrl: httpsUrl(tagText(b, "link")) ?? "",
      issuer: /\(([^)]+)\)/.exec(tagText(b, "author"))?.[1] ?? "",
      publishedAt: date(tagText(b, "pubDate")),
    }))
    .filter((i) => i.title && i.capUrl);
}

export interface CapInfo {
  event: string;
  severity: string;
  headline: string;
  effective: Date | null;
  expires: Date | null;
  area: string;
}

/** The parts of a CAP 1.2 alert the desk shows (first <info> block) */
export function parseCap(xml: string): CapInfo | null {
  const info = rawTag(xml, "cap:info") ?? rawTag(xml, "info");
  if (!info) return null;
  const t = (name: string) => tagText(info, `cap:${name}`) || tagText(info, name);
  return { event: t("event"), severity: t("severity"), headline: t("headline"), effective: date(t("effective")), expires: date(t("expires")), area: t("areaDesc") };
}

export type AlertLevel = "red" | "orange" | "yellow" | "info";

/** What an item carries: the desk's badge */
export interface ItemAlert {
  level: AlertLevel;
  title: string;
  validUntil?: string;
}

/** IMD's colour when the warning names one, else CAP severity: Extreme red, Severe orange, Moderate yellow */
export function alertLevel(text: string, severity: string): AlertLevel {
  const colour = /\b(red|orange|yellow)\b/i.exec(text)?.[1]?.toLowerCase() ?? /(लाल|नारंगी|ऑरेंज|पीला|येलो)/.exec(text)?.[1];
  const byColour: Record<string, AlertLevel> = { red: "red", orange: "orange", yellow: "yellow", "लाल": "red", "नारंगी": "orange", "ऑरेंज": "orange", "पीला": "yellow", "येलो": "yellow" };
  if (colour && byColour[colour]) return byColour[colour]!;
  return ({ extreme: "red", severe: "orange", moderate: "yellow" } as Record<string, AlertLevel>)[severity.toLowerCase()] ?? "info";
}

export interface TrendAlert {
  level: AlertLevel;
  /** The warning as issued */
  text: string;
  event: string;
  severity: string;
  validFrom: string | null;
  validUntil: string | null;
  districts: string[];
  issuer: string;
  url: string;
  source: "NDMA Sachet";
}

/** Rajasthan's alerts: issued by IMD Jaipur or Rajasthan's SDMA, or naming Rajasthan */
export function isRajasthanAlert(item: SachetItem): boolean {
  return /jaipur|rajasthan/i.test(item.issuer) || /rajasthan|राजस्थान/i.test(item.title);
}

// ─── Tagging ────────────────────────────────────────────────────────────────

export interface TrendTagger {
  /** District as written in English ("Sawai Madhopur"), or null */
  district(text: string): string | null;
  /** Every district named, in order */
  districts(text: string): string[];
  superTag(text: string): string;
  /** "राजस्थान" / "Rajasthan" or a district named in the text */
  rajasthan(text: string): number;
  /** Hashtags the org's rules give for this text: [{ latin, devanagari }] */
  ruleTags(text: string): { latin: string; devanagari: string | null; district: string | null }[];
}

interface PlaceData {
  name: string;
  latin: string;
  devanagari: string | null;
  isDistrict: boolean;
}

/** The org's hashtag rules (districts, cities, topics) plus the built-in district list. */
export function trendTagger(rules: HashtagRule[]): TrendTagger {
  const places: GazetteerEntry<PlaceData>[] = RAJASTHAN_DISTRICTS.map((d, i) => ({
    id: `d${i}`, name: d.name, aliases: [d.hi, ...d.aliases], priority: 0,
    data: { name: d.name, latin: d.name.replace(/[^A-Za-z0-9]/g, ""), devanagari: d.hi.replace(/[\s-]/g, ""), isDistrict: true },
  }));
  for (const r of rules) {
    const latinAlias = [r.name, ...r.aliases].find((a) => /^[A-Za-z][A-Za-z .-]*$/.test(a));
    const known = RAJASTHAN_DISTRICTS.find((d) => fold(d.name) === fold(latinAlias ?? "") || d.hi === r.name);
    places.push({
      id: `r${r.id}`, name: r.name, aliases: r.aliases, priority: r.priority + 10,
      data: {
        name: known?.name ?? latinAlias ?? r.hashtagLatin,
        latin: asHashtag(r.hashtagLatin).slice(1),
        devanagari: r.hashtagDevanagari ? asHashtag(r.hashtagDevanagari).slice(1) : null,
        isDistrict: r.matchType === "district" || r.matchType === "city",
      },
    });
  }
  const gazetteer = new Gazetteer(places);
  const words = Object.entries(SUPER_TAG_WORDS).map(([tag, list]) => ({ tag, list: list.map(fold) }));

  return {
    district(text) {
      // The district named first: headlines lead with the place
      const hits = gazetteer.find(text).filter((m) => m.entry.data.isDistrict).sort((a, b) => a.start - b.start);
      return hits[0]?.entry.data.name ?? null;
    },
    districts(text) {
      const hits = gazetteer.find(text).filter((m) => m.entry.data.isDistrict).sort((a, b) => a.start - b.start);
      return [...new Set(hits.map((m) => m.entry.data.name))];
    },
    superTag(text) {
      const folded = ` ${fold(text)} `;
      let best: { tag: string; n: number } | null = null;
      for (const { tag, list } of words) {
        const n = list.filter((w) => folded.includes(` ${w} `)).length;
        if (n > (best?.n ?? 0)) best = { tag, n };
      }
      return best?.tag ?? GENERAL_TAG;
    },
    rajasthan(text) {
      const tokens = fold(text).split(" ");
      const named = tokens.some((t) => RAJASTHAN_WORDS.has(t)) ? 1 : 0;
      return named + (gazetteer.find(text).some((m) => m.entry.data.isDistrict) ? 2 : 0);
    },
    ruleTags(text) {
      return gazetteer.find(text).map((m) => ({
        latin: `#${m.entry.data.latin}`,
        devanagari: m.entry.data.devanagari ? `#${m.entry.data.devanagari}` : null,
        district: m.entry.data.isDistrict ? m.entry.data.name : null,
      }));
    },
  };
}

// ─── Dedupe, grouping, ranking ──────────────────────────────────────────────

export function titleTokens(title: string): Set<string> {
  return new Set(fold(title).split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both);
}

/** How alike two titles are, 0..1 (higher is closer) */
type Likeness = (a: Set<string>, b: Set<string>) => number;

/** Same title as far as a reader can tell: Jaccard of the words */
const DUPLICATE: { likeness: Likeness; threshold: number } = { likeness: similarity, threshold: 0.7 };

/**
 * Same story told by different publishers: at least 3 shared words, covering a quarter of the shorter title.
 * Headlines differ in length a lot, so Jaccard alone splits a story that one paper tells at length.
 */
const SAME_TOPIC: { likeness: Likeness; threshold: number } = {
  likeness: (a, b) => {
    let both = 0;
    // "Rajasthan" is in nearly every headline here; it says nothing about which story
    for (const t of a) if (b.has(t) && !RAJASTHAN_WORDS.has(t)) both++;
    return both >= 3 ? both / Math.min(a.size, b.size) : 0;
  },
  threshold: 0.25,
};

export interface ArticleGroup {
  /** The article that stands for the group: the one with a picture, then the newest */
  lead: RawArticle;
  articles: RawArticle[];
  publishers: Set<string>;
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$|^oc$/i.test(k)) u.searchParams.delete(k);
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

function better(a: RawArticle, b: RawArticle): RawArticle {
  if (!!a.imageUrl !== !!b.imageUrl) return a.imageUrl ? a : b;
  if (a.platform !== b.platform && (a.platform === "RSS" || b.platform === "RSS")) return a.platform === "RSS" ? a : b;
  return (a.publishedAt?.getTime() ?? 0) >= (b.publishedAt?.getTime() ?? 0) ? a : b;
}

/** Greedy grouping by title similarity, after dropping repeats of the same URL. */
export function groupArticles(articles: RawArticle[], rule: { likeness: Likeness; threshold: number }): ArticleGroup[] {
  const seen = new Set<string>();
  const groups: (ArticleGroup & { tokens: Set<string> })[] = [];
  const sorted = [...articles].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  for (const a of sorted) {
    const key = canonicalUrl(a.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const tokens = titleTokens(a.title);
    let best: { g: (typeof groups)[number]; s: number } | null = null;
    for (const g of groups) {
      const s = rule.likeness(tokens, g.tokens);
      if (s >= rule.threshold && s > (best?.s ?? 0)) best = { g, s };
    }
    if (best) {
      best.g.articles.push(a);
      best.g.publishers.add(a.sourceName);
      best.g.lead = better(best.g.lead, a);
      for (const t of tokens) best.g.tokens.add(t);
    } else {
      groups.push({ lead: a, articles: [a], publishers: new Set([a.sourceName]), tokens });
    }
  }
  return groups.map(({ lead, articles: list, publishers }) => ({ lead, articles: list, publishers }));
}

export interface TrendRow {
  type: TrendType;
  window: TrendWindow;
  rank: number;
  title: string;
  url: string;
  platform: TrendPlatform;
  sourceName: string;
  reasonWhy: string;
  superTag: string;
  subTag: string;
  district: string | null;
  volume: string;
  growth: string;
  shares: string;
  publishedAt: Date | null;
  imageUrl: string | null;
  imageSource: string | null;
  /** What a draft is made from: a real news headline and its summary */
  headline: string;
  summary: string;
  /** A disaster warning in force for this district (NDMA Sachet), shown as an "Alert" badge */
  alert: ItemAlert | null;
  score: number;
}

/** Up to 2 real headlines, with their publishers */
function why(articles: RawArticle[], skip?: string): string {
  return articles
    .filter((a) => a.title !== skip)
    .slice(0, 2)
    .map((a) => `${cutText(a.title, 160)} (${a.sourceName})`)
    .join(" · ");
}

/** The words the group's headlines share most: a short label for the topic */
function label(articles: RawArticle[], max = 4): string {
  const counts = new Map<string, number>();
  for (const a of articles) for (const t of titleTokens(a.title)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const lead = articles[0]!.title;
  const order = (t: string) => fold(lead).split(" ").indexOf(t);
  const top = [...counts.entries()].filter(([, n]) => n > 1 || articles.length === 1).sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t);
  // Back to the words as written ("Rajasthan", not the folded "rajasthan")
  const written = new Map<string, string>();
  for (const a of articles) for (const w of a.title.split(/[^\p{L}\p{M}\p{N}]+/u)) if (w && !written.has(fold(w))) written.set(fold(w), w);
  return top.sort((a, b) => order(a) - order(b)).map((t) => written.get(t) ?? t).join(" ");
}

const ageHours = (d: Date | null, now: Date) => (d ? Math.max(0, (now.getTime() - d.getTime()) / 3600_000) : 0);

function score(relevance: number, volume: number, published: Date | null, windowHours: number, now: Date): number {
  const fresh = Math.max(0, 1 - ageHours(published, now) / windowHours);
  return relevance * 1000 + Math.min(volume, 50) * 10 + fresh * 50;
}

function newest(articles: RawArticle[]): Date | null {
  let best: Date | null = null;
  for (const a of articles) if (a.publishedAt && (!best || a.publishedAt > best)) best = a.publishedAt;
  return best;
}

const inWindow = (d: Date | null, hours: number, now: Date) => !d || ageHours(d, now) <= hours;

function topN(rows: Omit<TrendRow, "rank">[]): TrendRow[] {
  return rows
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, TREND_TOP)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** PascalCase hashtag from a Latin topic name ("jaipur metro" → "#JaipurMetro"); null for other scripts or long names. */
export function topicHashtag(name: string): string | null {
  const words = name.trim().split(/\s+/);
  if (!words.length || words.length > 4 || !words.every((w) => /^[A-Za-z0-9]+$/.test(w))) return null;
  const tag = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return tag.length >= 3 && tag.length <= 30 ? `#${tag}` : null;
}

export interface TrendInput {
  articles: RawArticle[];
  topics: RawTopic[];
  alerts?: TrendAlert[];
}

/** Headlines from the collected news that share a word with the topic, for topics that bring none (Wikipedia) */
function relatedNews(title: string, articles: RawArticle[]): RawArticle[] {
  const words = titleTokens(title);
  if (!words.size) return [];
  return articles.filter((a) => [...titleTokens(a.title)].some((t) => words.has(t))).slice(0, 2);
}

/** The alert that applies: same district, for weather topics and district hashtags; a state-wide alert for Rajasthan weather */
export function alertFor(row: Pick<TrendRow, "type" | "district" | "superTag">, alerts: TrendAlert[]): ItemAlert | null {
  const weather = row.superTag === "Weather";
  const a = alerts.find((x) => (row.district && x.districts.includes(row.district) && (weather || row.type === "hashtags")) || (!x.districts.length && weather));
  if (!a) return null;
  return { level: a.level, title: cutText(a.text, 200), ...(a.validUntil ? { validUntil: a.validUntil } : {}) };
}

/** Every type for every window, top 20 each, ranked Rajasthan first. */
export function buildTrends(input: TrendInput, tagger: TrendTagger, now: Date): TrendRow[] {
  const out: TrendRow[] = [];
  const unique = groupArticles(input.articles, DUPLICATE);
  const leads = unique.map((g) => ({ ...g.lead, dupes: g.articles.length, publishers: g.publishers }));
  const topicGroups = groupArticles(unique.map((g) => g.lead), SAME_TOPIC);

  for (const [window, hours] of Object.entries(TREND_WINDOWS) as [TrendWindow, number][]) {
    // Articles: one per duplicate set
    const articles = leads
      .filter((a) => inWindow(a.publishedAt, hours, now))
      .map((a): Omit<TrendRow, "rank"> => {
        const text = `${a.title} ${a.description}`;
        const relevance = tagger.rajasthan(text) + (a.rajasthanFeed ? 1 : 0);
        return {
          type: "articles", window, title: a.title, url: a.url, platform: a.platform, sourceName: a.sourceName,
          reasonWhy: cutText(a.description, 240), superTag: tagger.superTag(text), subTag: label([a], 3), district: tagger.district(text),
          volume: a.publishers.size > 1 ? plural(a.publishers.size, "publisher", "publishers") : "", growth: "", shares: "",
          publishedAt: a.publishedAt, imageUrl: a.imageUrl, imageSource: a.imageSource, headline: a.title, summary: a.description, alert: null,
          score: score(relevance, a.dupes, a.publishedAt, hours, now),
        };
      });
    out.push(...topN(articles));

    // Topics: groups of articles, and Google Trends searches
    const topics: Omit<TrendRow, "rank">[] = [];
    for (const g of topicGroups) {
      const list = g.articles.filter((a) => inWindow(a.publishedAt, hours, now));
      if (!list.length) continue;
      const lead = list.includes(g.lead) ? g.lead : list[0]!;
      const text = list.map((a) => a.title).join(" \n ");
      const relevance = tagger.rajasthan(text) + (list.some((a) => a.rajasthanFeed) ? 1 : 0);
      const publishers = new Set(list.map((a) => a.sourceName));
      const img = list.find((a) => a.imageUrl) ?? null;
      const name = label(list) || lead.title;
      topics.push({
        // The lead headline names the topic (real text); the shared words are its sub tag
        type: "topics", window, title: lead.title, url: lead.url, platform: lead.platform, sourceName: lead.sourceName,
        // The other publishers' headlines say why; a lone article gives its own
        reasonWhy: why(list.length > 1 ? list.filter((a) => a !== lead) : [lead]), superTag: tagger.superTag(text), subTag: name, district: tagger.district(text),
        volume: plural(list.length, "article", "articles"), growth: "", shares: publishers.size > 1 ? plural(publishers.size, "publisher", "publishers") : "",
        publishedAt: newest(list), imageUrl: img?.imageUrl ?? null, imageSource: img?.imageSource ?? null, headline: lead.title, summary: lead.description, alert: null,
        score: score(relevance, list.length + publishers.size, newest(list), hours, now),
      });
    }
    for (const t of input.topics) {
      if (!inWindow(t.publishedAt, hours, now)) continue;
      const news = t.news.length ? t.news : relatedNews(t.title, input.articles);
      const text = [t.title, ...news.map((n) => n.title)].join(" \n ");
      const lead = news[0];
      const sourceName = t.platform === "Wikipedia" ? "Hindi Wikipedia (most read)" : "Google Trends";
      topics.push({
        type: "topics", window, title: t.title, url: t.url ?? lead?.url ?? `https://trends.google.com/trends/explore?geo=IN&q=${encodeURIComponent(t.title)}`,
        platform: t.platform, sourceName, reasonWhy: why(news), superTag: tagger.superTag(text), subTag: t.title,
        district: tagger.district(text), volume: t.volume, growth: "",
        shares: t.news.length ? plural(new Set(t.news.map((n) => n.sourceName)).size, "publisher", "publishers") : "",
        publishedAt: t.publishedAt, imageUrl: t.imageUrl ?? lead?.imageUrl ?? null, imageSource: t.imageSource ?? lead?.imageSource ?? null,
        headline: lead?.title ?? t.title, summary: lead?.description ?? "", alert: null,
        score: score(tagger.rajasthan(text), Math.log10((t.trafficCount ?? 0) + 1) * 5 + t.news.length, t.publishedAt, hours, now),
      });
    }
    const rankedTopics = topN(topics);
    out.push(...rankedTopics);

    // Hashtags: from the ranked topics' names, districts and the org's topic rules
    const tags = new Map<string, { devanagari: string | null; district: string | null; topics: TrendRow[]; score: number }>();
    for (const t of rankedTopics) {
      const text = `${t.title} ${t.reasonWhy}`;
      const found = tagger.ruleTags(text);
      const named = topicHashtag(t.title);
      if (named) found.push({ latin: named, devanagari: null, district: null });
      const seen = new Set<string>();
      for (const f of found) {
        const key = fold(f.latin);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = tags.get(f.latin) ?? { devanagari: f.devanagari, district: f.district, topics: [], score: 0 };
        entry.topics.push(t);
        entry.score += t.score;
        tags.set(f.latin, entry);
      }
    }
    const hashtags = [...tags.entries()].map(([tag, e]): Omit<TrendRow, "rank"> => {
      const lead = e.topics[0]!;
      return {
        type: "hashtags", window, title: tag, url: lead.url, platform: lead.platform, sourceName: lead.sourceName,
        reasonWhy: e.topics.slice(0, 2).map((t) => t.headline).join(" · "), superTag: lead.superTag, subTag: e.devanagari ?? lead.title,
        district: e.district ?? lead.district, volume: plural(e.topics.length, "topic", "topics"), growth: "", shares: "",
        publishedAt: lead.publishedAt, imageUrl: lead.imageUrl, imageSource: lead.imageSource, headline: lead.headline, summary: lead.summary, alert: null,
        score: e.score,
      };
    });
    out.push(...topN(hashtags));
  }
  const alerts = input.alerts ?? [];
  for (const r of out) r.alert = alertFor(r, alerts);
  return out;
}
