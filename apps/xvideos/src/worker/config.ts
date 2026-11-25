// X Videos worker settings (apps/xvideos/.env). Its own process: nothing here is read by the X post desk's worker.

export const XV_ROLES = ["watch", "probe", "read"] as const;
export type XvRole = (typeof XV_ROLES)[number];

export interface XvWorkerConfig {
  /**
   * XVIDEOS_SPEECH=on: after the probe, each clip goes to the media service for speech, cuts and stills (the read
   * role). Off by default: a clip is ready on the desk once probed (length, size, poster).
   */
  speech: boolean;
  databaseUrl: string;
  /** XVIDEOS_LIVE_DB=yes: may run on the live database "socia" (only once X Videos is moved over) */
  allowLiveDb: boolean;
  orgId: string;
  roles: XvRole[];
  /** The video share root, read only: \\10.1.1.20\fin_data\EXPORT FOR YOUTUBE */
  shareRoot: string;
  /** Local folder for posters, frames and evidence files (never the share) */
  cacheDir: string;
  /** The media service (services/xvideos-media) and the key it requires; only used with speech on */
  mediaUrl: string;
  mediaKey: string;
  scanSeconds: number;
  ffprobe: string;
  ffmpeg: string;
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (X Videos worker, apps/xvideos/.env)`);
  return v;
}

function num(name: string, fallback: number, min: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number of at least ${min} (got "${v}")`);
  return n;
}

export function loadXvConfig(): XvWorkerConfig {
  const speech = process.env.XVIDEOS_SPEECH === "on";
  const roles = (process.env.XVIDEOS_ROLES ?? (speech ? "watch,probe,read" : "watch,probe")).split(",").map((r) => r.trim()).filter(Boolean);
  const bad = roles.filter((r) => !XV_ROLES.includes(r as XvRole));
  if (bad.length || !roles.length) throw new Error(`XVIDEOS_ROLES must list some of: ${XV_ROLES.join(", ")} (got "${roles.join(",")}")`);
  if (roles.includes("read") && !speech) throw new Error("The read role (speech) needs XVIDEOS_SPEECH=on");
  const databaseUrl = need("DATABASE_URL");
  return {
    // The database's real name is checked on the server at start (main.ts), not read from the URL
    allowLiveDb: process.env.XVIDEOS_LIVE_DB === "yes",
    speech,
    databaseUrl,
    orgId: need("ORG_ID"),
    roles: roles as XvRole[],
    shareRoot: need("XVIDEOS_SHARE"),
    cacheDir: need("XVIDEOS_CACHE"),
    mediaUrl: (process.env.XVIDEOS_MEDIA_URL ?? "http://127.0.0.1:8300").replace(/\/+$/, ""),
    mediaKey: speech ? need("XVIDEOS_MEDIA_KEY") : "",
    scanSeconds: num("XVIDEOS_SCAN_SECONDS", 30, 5),
    ffprobe: process.env.XVIDEOS_FFPROBE ?? "ffprobe",
    ffmpeg: process.env.XVIDEOS_FFMPEG ?? "ffmpeg",
  };
}
