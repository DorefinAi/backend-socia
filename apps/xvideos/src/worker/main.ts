// X Videos worker: its own process, apart from the X post desk's worker (which it never touches).
//   pnpm --filter @socia/xvideos worker      (reads apps/xvideos/.env; run from PowerShell: Git Bash cannot see the share)
// XVIDEOS_ROLES picks the loops: watch (the share) and probe (ffprobe + poster) by default; read (the media service:
// speech, cuts, stills) only with XVIDEOS_SPEECH=on.
// Set UV_THREADPOOL_SIZE=16 in the environment: a hung share call holds one of Node's pool threads until it returns.

import { createDb } from "@socia/db";
import { XV_LIVE_DB } from "../db/migrate";
import { sql } from "drizzle-orm";
import pino from "pino";
import { Loops } from "./loop";
import { loadXvConfig } from "./config";
import { XvProbeStep } from "./probe";
import { XvMediaClient, XvReadStep } from "./read";
import { XvShareReader } from "./share";
import { XvWatcher } from "./watch";

const log = pino({ base: { service: "socia-xvideos-worker" }, level: process.env.LOG_LEVEL ?? "info" });
process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "x videos worker: unhandled promise rejection; exiting");
  process.exit(1);
});

const config = loadXvConfig();
const { db, close } = createDb(config.databaseUrl, 4, { log: { error: (obj, msg) => log.error(obj, msg) } });

// The database's own name, from the server: the live one only once X Videos is moved over
const dbName = ((await db.execute<{ name: string }>(sql`select current_database() as name`)).rows[0]?.name ?? "") as string;
if (dbName === XV_LIVE_DB && !config.allowLiveDb) {
  log.fatal(`connected to the live database "${XV_LIVE_DB}"; X Videos runs on its test copy until moved over (XVIDEOS_LIVE_DB=yes)`);
  await close();
  process.exit(1);
}

const share = new XvShareReader(config.shareRoot);
const loops = new Loops();

if (config.roles.includes("watch")) {
  const watcher = new XvWatcher(db, config.orgId, share, log.child({ role: "watch" }));
  loops.start({ name: "xv-watch", tick: () => watcher.tick(), idleMs: config.scanSeconds * 1000, log });
}
if (config.roles.includes("probe")) {
  const probe = new XvProbeStep(db, share, config.cacheDir, { ffprobe: config.ffprobe, ffmpeg: config.ffmpeg }, log.child({ role: "probe" }), config.speech ? "read" : null);
  loops.start({ name: "xv-probe", tick: () => probe.tick(), idleMs: 2000, log });
}
if (config.roles.includes("read")) {
  const read = new XvReadStep(db, share, new XvMediaClient(config.mediaUrl, config.mediaKey), log.child({ role: "read" }));
  loops.start({ name: "xv-read", tick: () => read.tick(), idleMs: 3000, log });
}
log.info({ roles: config.roles, speech: config.speech, db: dbName }, "x videos worker started");

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "x videos worker stopping");
  await loops.stop();
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
