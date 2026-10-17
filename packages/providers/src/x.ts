// X API v2. Only the publish worker and the crons call this; nothing on an operator's click path
// waits on X except the publish itself.
//
// CONFIRM AGAINST LIVE DOCS BEFORE GO-LIVE (backend doc §8.3): X has moved the media upload and auth
// surface repeatedly. Built here: v2 media upload (multipart) and POST /2/tweets, with OAuth 1.0a
// user context (tokens do not expire, so no refresh chain for Phase 1) or an OAuth 2.0 bearer
// from a token provider.

import { createHmac, randomBytes } from "node:crypto";

export interface XMetrics {
  impressions: number | null;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  bookmarks: number;
}

export interface XPostSummary {
  id: string;
  text: string;
  createdAt: string | null;
}

export interface XClient {
  readonly mode: "api" | "fake";
  uploadImage(png: Uint8Array): Promise<string>;
  createPost(text: string, mediaIds: string[]): Promise<{ id: string }>;
  getPost(id: string): Promise<XPostSummary | null>;
  deletePost(id: string): Promise<void>;
  /** The account's own posts since a time; used to reconcile a job whose worker died mid-post */
  recentPosts(since: Date): Promise<XPostSummary[]>;
  /** Up to 100 ids per call */
  metrics(ids: string[]): Promise<Record<string, XMetrics>>;
  permalink(id: string): string;
}

export class XRateLimited extends Error {
  constructor(readonly resetAt: Date) {
    super(`X rate limit; resets at ${resetAt.toISOString()}`);
  }
}

export class XApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryable: boolean) {
    super(message);
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface XAuth {
  header(method: string, url: string, params?: Record<string, string>): Promise<string>;
}

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 encoding, as OAuth 1.0a requires (encodeURIComponent leaves !'()* alone). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The OAuth 1.0a Authorization header. `params` are query or form parameters that take part in the
 * signature; JSON and multipart bodies do not.
 */
export function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  params: Record<string, string> = {},
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): string {
  const parsed = new URL(url);
  const all: Record<string, string> = { ...params };
  parsed.searchParams.forEach((v, k) => (all[k] = v));
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const paramString = Object.entries({ ...all, ...oauth })
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const base = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(paramString)].join("&");
  const key = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");
  return (
    "OAuth " +
    Object.entries({ ...oauth, oauth_signature: signature })
      .map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`)
      .join(", ")
  );
}

export class OAuth1Auth implements XAuth {
  constructor(private readonly creds: OAuth1Credentials) {}
  async header(method: string, url: string, params?: Record<string, string>): Promise<string> {
    return oauth1Header(method, url, this.creds, params);
  }
}

/** OAuth 2.0 user context: the token provider owns refresh (single-flight, see the worker). */
export class BearerAuth implements XAuth {
  constructor(private readonly token: () => Promise<string>) {}
  async header(): Promise<string> {
    return `Bearer ${await this.token()}`;
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface XApiConfig {
  auth: XAuth;
  /** Account handle, for permalinks */
  username: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class XApiClient implements XClient {
  readonly mode = "api" as const;
  private readonly base: string;
  private readonly http: typeof fetch;
  private userId: string | null = null;

  constructor(private readonly cfg: XApiConfig) {
    this.base = cfg.baseUrl ?? "https://api.x.com";
    this.http = cfg.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, init: { json?: unknown; form?: FormData; query?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: await this.cfg.auth.header(method, url.toString()) };
    let body: RequestInit["body"];
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }

    const res = await this.http(url, { method, headers, body });
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      throw new XRateLimited(Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : new Date(Date.now() + 60_000));
    }
    const text = await res.text();
    if (!res.ok) {
      throw new XApiError(res.status, `X ${method} ${url.pathname} returned ${res.status}: ${text.slice(0, 300)}`, res.status >= 500);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async uploadImage(png: Uint8Array): Promise<string> {
    const form = new FormData();
    form.set("media", new Blob([new Uint8Array(png)], { type: "image/png" }), "card.png");
    form.set("media_category", "tweet_image");
    const res = await this.call<{ data?: { id: string }; media_id_string?: string }>("POST", "/2/media/upload", { form });
    const id = res.data?.id ?? res.media_id_string;
    if (!id) throw new XApiError(200, "X accepted the upload but returned no media id", false);
    return id;
  }

  async createPost(text: string, mediaIds: string[]): Promise<{ id: string }> {
    const res = await this.call<{ data: { id: string } }>("POST", "/2/tweets", {
      json: { text, ...(mediaIds.length && { media: { media_ids: mediaIds } }) },
    });
    return { id: res.data.id };
  }

  async getPost(id: string): Promise<XPostSummary | null> {
    try {
      const res = await this.call<{ data?: { id: string; text: string; created_at?: string } }>("GET", `/2/tweets/${id}`, { query: { "tweet.fields": "created_at" } });
      return res.data ? { id: res.data.id, text: res.data.text, createdAt: res.data.created_at ?? null } : null;
    } catch (e) {
      if (e instanceof XApiError && e.status === 404) return null;
      throw e;
    }
  }

  async deletePost(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/2/tweets/${id}`);
    } catch (e) {
      // Already gone counts as deleted
      if (!(e instanceof XApiError && e.status === 404)) throw e;
    }
  }

  private async me(): Promise<string> {
    if (!this.userId) {
      const res = await this.call<{ data: { id: string } }>("GET", "/2/users/me");
      this.userId = res.data.id;
    }
    return this.userId;
  }

  async recentPosts(since: Date): Promise<XPostSummary[]> {
    const res = await this.call<{ data?: { id: string; text: string; created_at?: string }[] }>("GET", `/2/users/${await this.me()}/tweets`, {
      query: { start_time: since.toISOString(), max_results: "50", "tweet.fields": "created_at" },
    });
    return (res.data ?? []).map((t) => ({ id: t.id, text: t.text, createdAt: t.created_at ?? null }));
  }

  async metrics(ids: string[]): Promise<Record<string, XMetrics>> {
    if (!ids.length) return {};
    if (ids.length > 100) throw new Error("X returns metrics for at most 100 posts per call");
    type PM = { impression_count?: number; like_count: number; reply_count: number; retweet_count: number; quote_count: number; bookmark_count?: number };
    const res = await this.call<{ data?: { id: string; public_metrics: PM }[] }>("GET", "/2/tweets", {
      query: { ids: ids.join(","), "tweet.fields": "public_metrics" },
    });
    const out: Record<string, XMetrics> = {};
    for (const t of res.data ?? []) {
      const m = t.public_metrics;
      out[t.id] = { impressions: m.impression_count ?? null, likes: m.like_count, replies: m.reply_count, reposts: m.retweet_count, quotes: m.quote_count, bookmarks: m.bookmark_count ?? 0 };
    }
    return out;
  }

  permalink(id: string): string {
    return `https://x.com/${this.cfg.username}/status/${id}`;
  }
}

/**
 * Development and test stand-in. Posts nothing anywhere; the worker logs loudly when it is in use.
 */
export class FakeXClient implements XClient {
  readonly mode = "fake" as const;
  readonly posts = new Map<string, XPostSummary>();
  private seq = 0;

  constructor(private readonly username = "socia_dev") {}

  async uploadImage(): Promise<string> {
    return `media-${++this.seq}`;
  }

  async createPost(text: string, _mediaIds: string[] = []): Promise<{ id: string }> {
    const id = `${Date.now()}${String(++this.seq).padStart(4, "0")}`;
    this.posts.set(id, { id, text, createdAt: new Date().toISOString() });
    return { id };
  }

  async getPost(id: string): Promise<XPostSummary | null> {
    return this.posts.get(id) ?? null;
  }

  async deletePost(id: string): Promise<void> {
    this.posts.delete(id);
  }

  async recentPosts(since: Date): Promise<XPostSummary[]> {
    return [...this.posts.values()].filter((p) => new Date(p.createdAt!) >= since);
  }

  async metrics(ids: string[]): Promise<Record<string, XMetrics>> {
    return Object.fromEntries(ids.map((id) => [id, { impressions: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: 0 }]));
  }

  permalink(id: string): string {
    return `https://x.com/${this.username}/status/${id}`;
  }
}
