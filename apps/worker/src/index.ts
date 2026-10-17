// One worker binary, several Render services. WORKER_ROLES picks what this instance does:
//   socia-ingest   WORKER_ROLES=ingest,pipeline   (singleton: one FTP watermark)
//   socia-render   WORKER_ROLES=render            (Docker, Playwright image)
//   socia-publish  WORKER_ROLES=publish,maintenance
//   crons          node dist/index.js --once metrics | --once handles

import { createDb } from "@socia/db";
import pino from "pino";
import { MemoryBucket, RedisBucket, type RateBucket } from "./bucket";
import { CardRenderer } from "./card/renderer";
import { loadConfig, makeSource, makeStorage, makeXClient } from "./config";
import { Loops } from "./loop";
import { Dictionaries, composeNext } from "./stages/compose";
import { convertNext } from "./stages/convert";
import { housekeeping, pullMetrics, syncHandles } from "./stages/crons";
import { Ingest } from "./stages/ingest";
import { Publisher } from "./stages/publish";
import { renderNext } from "./stages/render";

const log = pino({ base: { service: "socia-worker" }, level: process.env.LOG_LEVEL ?? "info" });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onceIndex = args.indexOf("--once");
  const once = onceIndex >= 0 ? args[onceIndex + 1] : null;
  const cfg = loadConfig(once ? [once] : args.filter((a) => !a.startsWith("--")));
  const { db, close } = createDb(cfg.databaseUrl, 5);

  if (once === "metrics") {
    await pullMetrics(db, makeXClient(), log);
    await close();
    return;
  }
  if (once === "handles") {
    await syncHandles(db, cfg.orgId, cfg.wikidataUserAgent, log);
    await close();
    return;
  }

  const loops = new Loops();
  const cleanups: (() => Promise<void>)[] = [];
  const storage = cfg.roles.some((r) => ["ingest", "pipeline", "render", "publish"].includes(r)) ? makeStorage() : null;

  if (cfg.roles.includes("ingest")) {
    const source = makeSource();
    cleanups.push(() => source.close());
    const ingest = new Ingest({ db, storage: storage!, source, orgId: cfg.orgId, log });
    loops.start({ name: "ingest", idleMs: cfg.pollSeconds * 1000, log, tick: async () => (await ingest.scan(), false) });
  }

  if (cfg.roles.includes("pipeline")) {
    const dictionaries = new Dictionaries(db, cfg.orgId);
    loops.start({ name: "convert", idleMs: 1000, log, tick: () => convertNext(db, storage!, log) });
    loops.start({ name: "compose", idleMs: 1000, log, tick: () => composeNext(db, dictionaries, log) });
  }

  if (cfg.roles.includes("render")) {
    const renderer = new CardRenderer(cfg.renderPool);
    await renderer.start();
    cleanups.push(() => renderer.close());
    for (let i = 0; i < cfg.renderPool; i++) {
      loops.start({ name: `render-${i}`, idleMs: 1000, log, tick: () => renderNext(db, storage!, renderer, log) });
    }
  }

  if (cfg.roles.includes("publish")) {
    const x = makeXClient();
    if (x.mode === "fake") log.warn("X_MODE=fake: nothing is really posted to X");
    const bucket: RateBucket = cfg.redisUrl ? new RedisBucket(cfg.redisUrl, cfg.xRate.tokens, cfg.xRate.windowSeconds) : new MemoryBucket(cfg.xRate.tokens, cfg.xRate.windowSeconds);
    cleanups.push(() => bucket.close());
    const publisher = new Publisher({ db, storage: storage!, x, bucket, account: process.env.X_USERNAME ?? "default", log, active: () => loops.active });
    loops.start({ name: "publish", idleMs: 1000, log, tick: () => publisher.tick() });
  }

  if (cfg.roles.includes("maintenance")) {
    loops.start({ name: "maintenance", idleMs: 30_000, log, tick: () => housekeeping(db, log) });
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "stopping: finishing work in flight");
    await loops.stop();
    for (const c of cleanups) await c().catch((err) => log.error({ err }, "cleanup failed"));
    await close();
    log.info("stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  log.info({ roles: cfg.roles }, "worker started");
}

main().catch((err) => {
  log.fatal({ err }, "worker failed to start");
  process.exit(1);
});
