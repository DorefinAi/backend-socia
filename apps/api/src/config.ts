import { LocalStorage, S3Storage, type Storage } from "@socia/providers";

export interface ApiConfig {
  databaseUrl: string;
  port: number;
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
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function loadConfig(): ApiConfig {
  return {
    databaseUrl: need("DATABASE_URL"),
    port: Number(process.env.PORT ?? 4000),
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: process.env.COOKIE_SECURE !== "false",
    sessionHours: Number(process.env.SESSION_HOURS ?? 12),
    requireTotp: process.env.REQUIRE_TOTP !== "false",
    secretKey: need("SECRET_KEY"),
    storageDir: process.env.STORAGE_DIR ?? null,
  };
}

export function makeStorage(cfg: ApiConfig): Storage {
  if (cfg.storageDir) return new LocalStorage(cfg.storageDir, process.env.STORAGE_PUBLIC_BASE ?? `http://localhost:${cfg.port}/dev-files`);
  return new S3Storage({
    endpoint: need("S3_ENDPOINT"),
    bucket: need("S3_BUCKET"),
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    region: process.env.S3_REGION,
  });
}
