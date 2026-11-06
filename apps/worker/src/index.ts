// One worker binary, several Render services. WORKER_ROLES picks what this instance does:
//   socia-ingest   WORKER_ROLES=ingest,pipeline   (singleton: one FTP watermark / Samvadia cursor;
//                  SOURCE_MODE=samvadia|folder|ftp picks where stories come from)
//   socia-render   WORKER_ROLES=render            (Docker, Playwright image)
//   socia-publish  WORKER_ROLES=publish,maintenance
//   socia-trends   WORKER_ROLES=trends            (singleton: the Web Scraper's free public sources)
//   crons          node dist/index.js --once handles
// PHASE=1: the breaking share (SOURCE_LAYOUT=breaking), drafts with no card until asked for, the publish role
// does not start, and Samvadia ingest is refused at config load.

import {
  OpsLog, SamvadiaReader, WORKER_HEARTBEAT_MS, WORKER_STAGE_SYSTEMS, createDb, opsLogSettings, readApiPhase, recordDataFileStatus, recordIngestPoll, recordWorkerHeartbeat, workerSystemOf,
} from "@socia/db";
import pino from "pino";
import { MemoryBucket, RedisBucket, type RateBucket } from "./bucket";
import { CardRenderer } from "./card/renderer";
import { politeGet } from "@socia/providers";
import { BreakingShareSource, ShareUnreachable } from "./breaking-source";
import { loadConfig, makeFootage, makeSource, makeStorage, makeXClient, need, samvadiaConfig, trendsConfig } from "./config";

import { SamvadiaIngest } from "./stages/samvadia";
import { Loops } from "./loop";
import { Dictionaries, composeNext } from "./stages/compose";
import { phaseOneData } from "./data-files";
import { convertNext } from "./stages/convert";
import { housekeeping, syncHandles } from "./stages/crons";
import { Ingest } from "./stages/ingest";
import { Publisher } from "./stages/publish";
import { renderNext } from "./stages/render";
import { TrendsJob } from "./stages/trends";

// Ops logs for the Sentry control centre (dev-docs/ops-logs-contract.md): stdout exactly as before, plus every line
// at OPS_LOG_LEVEL and above queued for ops_log. The system comes from the `stage` binding of the role's child
// logger below (socia-ingest / -render / -publish / -crons; none = socia-ingest).
const stdoutLevel = process.env.LOG_LEVEL ?? "info";
const ops = opsLogSettings();
const opsLog = new OpsLog({ databaseUrl: process.env.DATABASE_URL ?? "", system: "socia-ingest", systemOf: workerSystemOf, enabled: ops.enabled });
const lowerLevel = (a: string, b: string) => ((pino.levels.values[a] ?? 30) <= (pino.levels.values[b] ?? 30) ? a : b);
const log = ops.enabled
  ? pino(
      { base: { service: "socia-worker" }, level: lowerLevel(stdoutLevel, ops.level) },
      pino.multistream([
        { level: stdoutLevel as pino.Level, stream: pino.destination(1) },
        { level: ops.level, stream: opsLog.stream },
      ]),
    )
  : pino({ base: { service: "socia-worker" }, level: stdoutLevel });
type Stage = "ingest" | "render" | "publish" | "crons";
/** WORKER_ROLES → the stage its lines are filed under in Sentry */
const ROLE_STAGES: Record<string, Stage> = {
  ingest: "ingest", pipeline: "ingest", trends: "ingest", render: "render", publish: "publish", maintenance: "crons",
};
const stageLog = (stage: Stage) => log.child({ stage });

// A crash is logged and the process exits non-zero so the supervisor starts it again. The loops catch their
// own errors (the database down included) and back off, so reaching these means a bug, not an outage.
// The queued ops-log lines (this fatal one included) are flushed first so the crash reaches Sentry (at most 2 s).
let exiting = false;
const crashExit = () => {
  if (exiting) return;
  exiting = true;
  void opsLog.close(2000).catch(() => undefined).finally(() => process.exit(1));
};
process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "unhandled promise rejection; exiting");
  crashExit();
});
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception; exiting");
  crashExit();
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onceIndex = args.indexOf("--once");
  const once = onceIndex >= 0 ? args[onceIndex + 1] : null;
  const cfg = loadConfig(once ? [once] : args.filter((a) => !a.startsWith("--")));
  // A dropped idle connection (Postgres restarted) is logged and replaced, not fatal
  const { db, close } = createDb(cfg.databaseUrl, 5, { log });

  if (once === "handles") {
    await syncHandles(db, cfg.orgId, cfg.wikidataUserAgent, stageLog("crons"));
    await close();
    await opsLog.close();
    return;
  }

  // ops_heartbeat: one row per worker service (named by its roles), filed under its first role's stage
  opsLog.startHeartbeat({
    process: `worker:${cfg.roles.join(",")}`,
    system: WORKER_STAGE_SYSTEMS[ROLE_STAGES[cfg.roles[0] ?? ""] ?? "ingest"]!,
    info: { roles: cfg.roles, phase: cfg.phase },
  });

  const loops = new Loops();
  const cleanups: (() => Promise<void>)[] = [];
  const storage = cfg.roles.some((r) => ["ingest", "pipeline", "render", "publish"].includes(r)) ? makeStorage() : null;

  if (cfg.roles.includes("ingest") && cfg.sourceMode === "samvadia") {
    const log = stageLog("ingest");
    const sc = samvadiaConfig();
    const reader = new SamvadiaReader(sc.databaseUrl);
    const footage = makeFootage();
    cleanups.push(() => reader.close(), () => footage.close());
    const ingest = new SamvadiaIngest({ db, storage: storage!, reader, footage, orgId: cfg.orgId, log, media: sc.media, rescanMs: sc.rescanMs, backfillHours: sc.backfillHours });
    log.info({ footage: footage.kind, media: sc.media, rescanSeconds: sc.rescanMs / 1000 }, "ingest: Samvadia approved stories + FTP footage (read only)");
    loops.start({ name: "ingest", idleMs: cfg.pollSeconds * 1000, log, tick: async () => (await ingest.poll(), false) });
  } else if (cfg.roles.includes("ingest")) {
    const log = stageLog("ingest");
    const breaking = cfg.sourceLayout === "breaking";
    const share = breaking ? new BreakingShareSource(need("SOURCE_DIR"), { log }) : null;
    const source = share ?? makeSource(cfg.sourceMode);
    cleanups.push(() => source.close());
    // The breaking share holds the whole day already: a first start takes only what arrives from then on
    const ingest = new Ingest({ db, storage: storage!, source, orgId: cfg.orgId, log, ...(breaking && { layout: "breaking" as const, startFromNow: true }) });
    const mode = cfg.sourceMode;
    log.info({ mode, layout: cfg.sourceLayout }, breaking ? "ingest: breaking files from the share (read only)" : "ingest: text files from the share");
    let wasDown = false;
    loops.start({
      name: "ingest",
      idleMs: cfg.pollSeconds * 1000,
      log,
      tick: async () => {
        try {
          const taken = await ingest.scan();
          await recordIngestPoll(db, cfg.orgId, { mode, taken, cursor: null, ...(share && { source: share.health() }) }).catch((e) => log.error({ err: e }, "could not record the ingest status"));
          if (wasDown) log.info("the share is readable again");
          wasDown = false;
        } catch (err) {
          const unreachable = err instanceof ShareUnreachable;
          // Shown to the desk: plain words, never a server path (the log below keeps the details)
          const message = unreachable ? err.message : "The last scan failed; see the worker log.";
          await recordIngestPoll(db, cfg.orgId, { mode, taken: 0, error: share ? message : String((err as Error)?.message ?? err).slice(0, 500), cursor: null, ...(share && { source: share.health(), quietRepeats: true }) }).catch(
            (e) => log.error({ err: e }, "could not record the ingest status"),
          );
          // A share that is down stays down for a while: say so once, not every few seconds. Anything else (the
          // database, storage, a bug) goes to the loop, which logs it and backs off.
          if (!unreachable) throw err;
          if (!wasDown) log.error({ err }, "the share cannot be read; waiting for it");
          wasDown = true;
        }
        return false;
      },
    });
  }

  // The desk's health light and GET /healthz/worker call the worker stopped after 90 s without a poll or a beat.
  // A beat apart from the polls, so a long scan or footage copy does not look like a stopped worker.
  let heartbeat: NodeJS.Timeout | null = null;
  if (cfg.roles.includes("ingest")) {
    const log = stageLog("ingest");
    let beatFailed = false;
    // One beat at a time: a slow database (connect timeout 10 s) never piles them up
    let beating = false;
    const beat = () => {
      if (beating) return;
      beating = true;
      void recordWorkerHeartbeat(db)
        .then(() => {
          if (beatFailed) log.info("heartbeat recorded again");
          beatFailed = false;
        })
        .catch((err) => {
          // Once per outage: the loops already log the database being down
          if (!beatFailed) log.warn({ err }, "could not record the worker heartbeat");
          beatFailed = true;
        })
        .finally(() => {
          beating = false;
        });
    };
    beat();
    heartbeat = setInterval(beat, WORKER_HEARTBEAT_MS);
  }

  if (cfg.roles.includes("pipeline")) {
    const log = stageLog("ingest");
    const dictionaries = new Dictionaries(db, cfg.orgId);
    const data = phaseOneData(log, (status) => recordDataFileStatus(db, status));
    const composeOpts = { cardOnDemand: cfg.phase === 1, data };
    loops.start({ name: "convert", idleMs: 1000, log, tick: () => convertNext(db, storage!, log, data) });
    loops.start({ name: "compose", idleMs: 1000, log, tick: () => composeNext(db, dictionaries, log, composeOpts) });
  }

  if (cfg.roles.includes("render")) {
    const log = stageLog("render");
    const renderer = new CardRenderer(cfg.renderPool);
    await renderer.start();
    cleanups.push(() => renderer.close());
    for (let i = 0; i < cfg.renderPool; i++) {
      loops.start({ name: `render-${i}`, idleMs: 1000, log, tick: () => renderNext(db, storage!, renderer, log) });
    }
  }

  // Phase 1 posts by hand (Copy & Posted): nothing may reach the X API, whatever the roles say. PHASE is set on the
  // API and the worker separately, so the API's value (written at its start) is checked too.
  const apiPhase = cfg.roles.includes("publish") ? await readApiPhase(db) : null;
  if (apiPhase && apiPhase.phase !== cfg.phase) {
    stageLog("publish").error({ workerPhase: cfg.phase, apiPhase: apiPhase.phase, apiStartedAt: apiPhase.at }, "PHASE differs between the API and this worker: set the same PHASE on both");
  }
  if (cfg.roles.includes("publish") && (cfg.phase === 1 || apiPhase?.phase === 1)) {
    stageLog("publish").error({ workerPhase: cfg.phase, apiPhase: apiPhase?.phase ?? null }, "PHASE=1: the publish role is NOT started (posting is Copy & Posted by hand); maintenance still runs");
  } else if (cfg.roles.includes("publish")) {
    const log = stageLog("publish");
    const x = makeXClient();
    if (x.mode === "fake") log.warn("X_MODE=fake: nothing is really posted to X");
    const bucket: RateBucket = cfg.redisUrl ? new RedisBucket(cfg.redisUrl, cfg.xRate.tokens, cfg.xRate.windowSeconds) : new MemoryBucket(cfg.xRate.tokens, cfg.xRate.windowSeconds);
    cleanups.push(() => bucket.close());
    const publisher = new Publisher({ db, storage: storage!, x, bucket, account: process.env.X_USERNAME ?? "default", log, active: () => loops.active });
    loops.start({ name: "publish", idleMs: 1000, log, tick: () => publisher.tick() });
  }

  if (cfg.roles.includes("trends")) {
    const log = stageLog("ingest");
    const settings = trendsConfig();
    const job = new TrendsJob({ db, orgId: cfg.orgId, get: politeGet(settings.userAgent), settings, log });
    log.info({ pollSeconds: settings.pollMs / 1000, feeds: settings.plan.feeds.map((f) => f.name), gdelt: settings.plan.gdelt }, "trends: free public sources");
    // Checks every 5 s whether a run is due or the desk asked for one; a run itself takes a few seconds
    loops.start({ name: "trends", idleMs: 5000, log, tick: () => job.tick() });
  }

  if (cfg.roles.includes("maintenance")) {
    const log = stageLog("crons");
    loops.start({ name: "maintenance", idleMs: 30_000, log, tick: () => housekeeping(db, log) });
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "stopping: finishing work in flight");
    if (heartbeat) clearInterval(heartbeat);
    await loops.stop();
    for (const c of cleanups) await c().catch((err) => log.error({ err }, "cleanup failed"));
    await close();
    log.info("stopped");
    // Best effort: the last queued lines (at most 3 s), then its own pool
    await opsLog.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  log.info({ roles: cfg.roles, phase: cfg.phase }, "worker started");
}

main().catch((err) => {
  log.fatal({ err }, "worker failed to start");
  // So the reason reaches Sentry too (best effort, at most 2 s)
  void opsLog.close(2000).finally(() => process.exit(1));
});
