import { phaseFrom, rewriteModeFrom, type Phase, type RewriteMode } from "@socia/core";
import { LocalStorage, S3Storage, type Storage } from "@socia/providers";

export interface ApiConfig {
  databaseUrl: string;
  /** PHASE: 1 = Copy & Posted only (X API posting refused); 2 or unset = everything. Absent means 2. */
  phase?: Phase;
  port: number;
  /**
   * HOST: the address the API listens on. Unset: 127.0.0.1, so only this machine (the desk's /socia-api
   * proxy, the worker, the owner console) can reach it. 0.0.0.0 when browsers call the API directly
   * (office LAN on :8200) or on Render.
   */
  host?: string;
  /** REALTIME=true: also serve Socket.IO on the API port. Off by default: the desk polls and nothing connects. */
  realtime?: boolean;
  /** Browser origins allowed to call the API with cookies, e.g. https://digital.<domain> */
  corsOrigins: string[];
  cookieSecure: boolean;
  sessionHours: number;
  /** When true, every user must set up and use TOTP before anything else works */
  requireTotp: boolean;
  /** 32 bytes, base64: encrypts TOTP seeds and platform tokens */
  secretKey: string;
  /** Development only: serve LocalStorage files at /dev-files */
  storageDir: string | null;
  /** REWRITE_MODE: how Web Scraper drafts are reworded; resolved at load ("rules" when unset, the only mode for now) */
  rewriteMode: RewriteMode;
  /**
   * TRUST_PROXY: which proxies may set X-Forwarded-For (and so req.ip, the sign-in rate-limit key).
   * Unset (default): ["loopback"], only a proxy on this machine (the desk's Next.js /socia-api rewrite) is
   * trusted, so req.ip is the right-most non-loopback X-Forwarded-For entry; a remote client's own header is
   * ignored. false: the socket address, X-Forwarded-For always ignored. A number: that many proxy hops in front
   * (1 behind Render or one load balancer); only safe when the API cannot be reached without passing the
   * proxy. A list: the proxies' addresses/CIDRs (safer when known). Never `true`: any client could then pick
   * its own IP.
   */
  trustProxy: TrustProxy;
  /**
   * OWNER_API_KEY: the bearer key of the owner console's server-to-server API (/owner, routes/owner.ts).
   * null (unset or shorter than OWNER_KEY_MIN) turns every /owner route off (404).
   */
  ownerApiKey?: string | null;
}

export const OWNER_KEY_MIN = 32;

/** OWNER_API_KEY, or null when unset or too short to be safe (the /owner routes are then off) */
export function ownerKeyFrom(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length >= OWNER_KEY_MIN ? v : null;
}

export type TrustProxy = false | number | string[];

/** Unset TRUST_PROXY: trust only proxies on this machine (127.0.0.0/8, ::1) */
export const DEFAULT_TRUST_PROXY: TrustProxy = ["loopback"];

/** Parses TRUST_PROXY; an unusable value stops startup instead of trusting the wrong hops */
export function trustProxyFrom(value: string | undefined): TrustProxy {
  const v = (value ?? "").trim();
  if (!v) return DEFAULT_TRUST_PROXY;
  if (v.toLowerCase() === "false" || v === "0") return false;
  if (/^\d+$/.test(v)) return Number(v);
  if (v.toLowerCase() === "true") {
    throw new Error("TRUST_PROXY=true would let any client set its own IP. Use the number of proxy hops (e.g. 1) or the proxies' addresses.");
  }
  const list = v.split(",").map((x) => x.trim()).filter(Boolean);
  const bad = list.filter((x) => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x) && !["loopback", "linklocal", "uniquelocal"].includes(x));
  if (bad.length) throw new Error(`TRUST_PROXY: not an address, CIDR or hop count: ${bad.join(", ")}`);
  return list;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function loadConfig(): ApiConfig {
  return {
    databaseUrl: need("DATABASE_URL"),
    // An unknown phase stops startup rather than running the wrong product
    phase: phaseFrom(process.env.PHASE),
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST?.trim() || "127.0.0.1",
    realtime: process.env.REALTIME === "true",
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: process.env.COOKIE_SECURE !== "false",
    sessionHours: Number(process.env.SESSION_HOURS ?? 12),
    requireTotp: process.env.REQUIRE_TOTP !== "false",
    secretKey: need("SECRET_KEY"),
    storageDir: process.env.STORAGE_DIR ?? null,
    // An unknown mode stops startup instead of drafting with the wrong rewriter
    rewriteMode: rewriteModeFrom(process.env.REWRITE_MODE),
    trustProxy: trustProxyFrom(process.env.TRUST_PROXY),
    ownerApiKey: ownerKeyFrom(process.env.OWNER_API_KEY),
  };
}

export function makeStorage(cfg: Pick<ApiConfig, "storageDir" | "port">): Storage {
  if (cfg.storageDir) return new LocalStorage(cfg.storageDir, process.env.STORAGE_PUBLIC_BASE ?? `http://localhost:${cfg.port}/dev-files`);
  return new S3Storage({
    endpoint: need("S3_ENDPOINT"),
    bucket: need("S3_BUCKET"),
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    region: process.env.S3_REGION,
  });
}
