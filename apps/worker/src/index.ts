// One worker binary, several Render services. WORKER_ROLES picks what this instance does:
//   socia-ingest   WORKER_ROLES=ingest,pipeline   (singleton: one FTP watermark / Samvadia cursor;
//                  SOURCE_MODE=samvadia|folder|ftp picks where stories come from)
//   socia-render   WORKER_ROLES=render            (Docker, Playwright image)
//   socia-publish  WORKER_ROLES=publish,maintenance
//   socia-trends   WORKER_ROLES=trends            (singleton: the Web Scraper's free public sources)
//   crons          node dist/index.js --once handles

import { SamvadiaReader, createDb, recordIngestPoll } from "@socia/db";
import pino from "pino";
import { MemoryBucket, RedisBucket, type RateBucket } from "./bucket";
import { CardRenderer } from "./card/renderer";
import { politeGet } from "@socia/providers";
import { loadConfig, makeFootage, makeSource, makeStorage, makeXClient, samvadiaConfig, trendsConfig } from "./config";

import { SamvadiaIngest } from "./stages/samvadia";
import { Loops } from "./loop";
import { Dictionaries, composeNext } from "./stages/compose";
import { convertNext } from "./stages/convert";
import { housekeeping, syncHandles } from "./stages/crons";
import { Ingest } from "./stages/ingest";
import { Publisher } from "./stages/publish";
import { renderNext } from "./stages/render";
import { TrendsJob } from "./stages/trends";

const log = pino({ base: { service: "socia-worker" }, level: process.env.LOG_LEVEL ?? "info" });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onceIndex = args.indexOf("--once");
  const once = onceIndex >= 0 ? args[onceIndex + 1] : null;
  const cfg = loadConfig(once ? [once] : args.filter((a) => !a.startsWith("--")));
  const { db, close } = createDb(cfg.databaseUrl, 5);

  if (once === "handles") {
    await syncHandles(db, cfg.orgId, cfg.wikidataUserAgent, log);
    await close();
    return;
  }

  const loops = new Loops();
  const cleanups: (() => Promise<void>)[] = [];
  const storage = cfg.roles.some((r) => ["ingest", "pipeline", "render", "publish"].includes(r)) ? makeStorage() : null;

  if (cfg.roles.includes("ingest") && cfg.sourceMode === "samvadia") {
    const sc = samvadiaConfig();
    const reader = new SamvadiaReader(sc.databaseUrl);
    const footage = makeFootage();
    cleanups.push(() => reader.close(), () => footage.close());
    const ingest = new SamvadiaIngest({ db, storage: storage!, reader, footage, orgId: cfg.orgId, log, media: sc.media, rescanMs: sc.rescanMs, backfillHours: sc.backfillHours });
    log.info({ footage: footage.kind, media: sc.media, rescanSeconds: sc.rescanMs / 1000 }, "ingest: Samvadia approved stories + FTP footage (read only)");
    loops.start({ name: "ingest", idleMs: cfg.pollSeconds * 1000, log, tick: async () => (await ingest.poll(), false) });
  } else if (cfg.roles.includes("ingest")) {
    const source = makeSource(cfg.sourceMode);
    cleanups.push(() => source.close());
    const ingest = new Ingest({ db, storage: storage!, source, orgId: cfg.orgId, log });
    const mode = cfg.sourceMode;
    log.info({ mode }, "ingest: text files from the share");
    loops.start({
      name: "ingest",
      idleMs: cfg.pollSeconds * 1000,
      log,
      tick: async () => {
        try {
          const taken = await ingest.scan();
          await recordIngestPoll(db, cfg.orgId, { mode, taken, cursor: null });
        } catch (err) {
          await recordIngestPoll(db, cfg.orgId, { mode, taken: 0, error: String((err as Error)?.message ?? err).slice(0, 500), cursor: null }).catch(() => undefined);
          throw err;
        }
        return false;
      },
    });
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

  if (cfg.roles.includes("trends")) {
    const settings = trendsConfig();
    const job = new TrendsJob({ db, orgId: cfg.orgId, get: politeGet(settings.userAgent), settings, log });
    log.info({ pollSeconds: settings.pollMs / 1000, feeds: settings.plan.feeds.map((f) => f.name), gdelt: settings.plan.gdelt }, "trends: free public sources");
    // Checks every 5 s whether a run is due or the desk asked for one; a run itself takes a few seconds
    loops.start({ name: "trends", idleMs: 5000, log, tick: () => job.tick() });
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
