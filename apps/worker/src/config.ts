// Every setting comes from the environment (Render dashboard in production, .env locally).

import {
  FakeXClient, FolderFootage, FolderSource, FtpFootage, FtpSource, LocalStorage, OAuth1Auth, S3Storage, XApiClient,
  type FileSource, type FootageSource, type Storage, type XClient,
} from "@socia/providers";
import type { MediaSettings } from "./stages/samvadia";

export const ROLES = ["ingest", "pipeline", "render", "publish", "maintenance", "metrics", "handles"] as const;
export type Role = (typeof ROLES)[number];

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const SOURCE_MODES = ["samvadia", "folder", "ftp"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];

export interface WorkerConfig {
  databaseUrl: string;
  /** Where stories come from: Samvadia's database (+ FTP footage), or text files in a folder / on the FTP */
  sourceMode: SourceMode;
  orgId: string;
  roles: Role[];
  pollSeconds: number;
  renderPool: number;
  xRate: { tokens: number; windowSeconds: number };
  redisUrl: string | null;
  wikidataUserAgent: string;
}

export function loadConfig(argvRoles?: string[]): WorkerConfig {
  const roles = (argvRoles?.length ? argvRoles : (process.env.WORKER_ROLES ?? "").split(",")).map((r) => r.trim()).filter(Boolean);
  const bad = roles.filter((r) => !ROLES.includes(r as Role));
  if (bad.length || !roles.length) throw new Error(`WORKER_ROLES must list some of: ${ROLES.join(", ")} (got "${roles.join(",")}")`);
  return {
    databaseUrl: need("DATABASE_URL"),
    sourceMode: sourceMode(),
    orgId: need("ORG_ID"),
    roles: roles as Role[],
    pollSeconds: num("FTP_POLL_SECONDS", 5),
    renderPool: num("RENDER_POOL", 3),
    xRate: { tokens: num("X_RATE_TOKENS", 100), windowSeconds: num("X_RATE_WINDOW_SECONDS", 900) },
    redisUrl: process.env.REDIS_URL ?? null,
    wikidataUserAgent: process.env.WIKIDATA_USER_AGENT ?? "Socia/0.1 (handle directory seed; contact: tech@dorefin.ai)",
  };
}

/** SOURCE_MODE, or the old behaviour when it is unset: SOURCE_DIR means folder, otherwise FTP. */
export function sourceMode(): SourceMode {
  const v = process.env.SOURCE_MODE?.trim().toLowerCase();
  if (!v) return process.env.SOURCE_DIR ? "folder" : "ftp";
  if (!SOURCE_MODES.includes(v as SourceMode)) throw new Error(`SOURCE_MODE must be one of ${SOURCE_MODES.join(", ")} (got "${v}")`);
  return v as SourceMode;
}

export interface SamvadiaConfig {
  databaseUrl: string;
  media: MediaSettings;
  rescanMs: number;
  backfillHours: number;
}

export function samvadiaConfig(): SamvadiaConfig {
  const types = (process.env.MEDIA_TYPES ?? "jpg,jpeg,png,webp,mp4,mov").split(",").map((t) => t.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
  return {
    databaseUrl: need("SAMVADIA_DATABASE_URL"),
    media: { types, maxBytes: Math.round(num("MEDIA_MAX_MB", 25) * 1024 * 1024), video: process.env.MEDIA_VIDEO === "true" },
    rescanMs: num("MEDIA_RESCAN_SECONDS", 60) * 1000,
    backfillHours: num("SAMVADIA_BACKFILL_HOURS", 24),
  };
}

/** Footage folders: FOOTAGE_DIR (a local copy of the FTP layout, development) or the newsroom FTP, read only. */
export function makeFootage(): FootageSource {
  if (process.env.FOOTAGE_DIR) return new FolderFootage(process.env.FOOTAGE_DIR);
  return new FtpFootage({
    host: need("FTP_HOST"),
    port: num("FTP_PORT", 21),
    user: need("FTP_USER"),
    password: need("FTP_PASSWORD"),
    secure: process.env.FTP_SECURE === "true",
  });
}

export function makeStorage(): Storage {
  if (process.env.STORAGE_DIR) {
    return new LocalStorage(process.env.STORAGE_DIR, process.env.STORAGE_PUBLIC_BASE ?? "http://localhost:4000/dev-files");
  }
  return new S3Storage({
    endpoint: need("S3_ENDPOINT"),
    bucket: need("S3_BUCKET"),
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    region: process.env.S3_REGION,
  });
}

export function makeSource(mode: SourceMode = sourceMode()): FileSource {
  if (mode === "folder") return new FolderSource(need("SOURCE_DIR"), num("FTP_DEPTH", 2));
  return new FtpSource({
    host: need("FTP_HOST"),
    port: num("FTP_PORT", 21),
    user: need("FTP_USER"),
    password: need("FTP_PASSWORD"),
    secure: process.env.FTP_SECURE === "true",
    root: process.env.FTP_ROOT ?? "/",
    depth: num("FTP_DEPTH", 2),
  });
}

export function makeXClient(): XClient {
  if ((process.env.X_MODE ?? "fake") === "fake") return new FakeXClient(process.env.X_USERNAME ?? "socia_dev");
  return new XApiClient({
    username: need("X_USERNAME"),
    auth: new OAuth1Auth({
      consumerKey: need("X_CONSUMER_KEY"),
      consumerSecret: need("X_CONSUMER_SECRET"),
      token: need("X_ACCESS_TOKEN"),
      tokenSecret: need("X_ACCESS_TOKEN_SECRET"),
    }),
  });
}
