import { OpsLog, createDb, opsLogSettings, recordApiPhase, type DbLogger } from "@socia/db";
import pino from "pino";
import { buildApp } from "./app";
import { loadConfig, makeStorage } from "./config";
import { attachRealtime } from "./realtime";

// Until Fastify's logger exists, the console. A crash is logged and the process exits non-zero so the
// supervisor starts it again; nothing tries to carry on in an unknown state.
let log: DbLogger & { fatal: (obj: object, msg: string) => void } = {
  error: (obj, msg) => console.error(msg, obj),
  fatal: (obj, msg) => console.error(msg, obj),
};
// Set once the ops log exists, so the fatal line reaches Sentry before the exit (best effort, at most 2 s)
let flushOpsLog: (() => Promise<void>) | null = null;
let exiting = false;
const crashExit = () => {
  if (exiting) return;
  exiting = true;
  void (flushOpsLog?.() ?? Promise.resolve()).catch(() => undefined).finally(() => process.exit(1));
};
process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "unhandled promise rejection; exiting");
  crashExit();
});
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception; exiting");
  crashExit();
});

const config = loadConfig();
// A dropped idle connection (Postgres restarted) is logged and replaced, not fatal
const { db, close } = createDb(config.databaseUrl, 10, { log: { error: (obj, msg) => log.error(obj, msg) } });
// Ops logs for the Sentry control centre (dev-docs/ops-logs-contract.md): stdout exactly as before (Fastify's default,
// info), plus every line at OPS_LOG_LEVEL and above queued for ops_log; the heartbeat runs either way
const ops = opsLogSettings();
const opsLog = new OpsLog({ databaseUrl: config.databaseUrl, system: "socia-api", enabled: ops.enabled });
flushOpsLog = () => opsLog.close(2000);
opsLog.startHeartbeat({ process: "api", system: "socia-api", info: { phase: config.phase ?? 2 } });
const logger = ops.enabled
  ? {
      level: pino.levels.values[ops.level]! < pino.levels.values.info! ? ops.level : "info",
      stream: pino.multistream([
        { level: "info", stream: pino.destination(1) },
        { level: ops.level, stream: opsLog.stream },
      ]),
    }
  : true;
const app = await buildApp({ db, storage: makeStorage(config), config, opsLog }, logger);
log = app.log;
// The worker compares its own PHASE with this before it starts anything that posts to X
await recordApiPhase(db, config.phase ?? 2);

await app.listen({ host: config.host ?? "127.0.0.1", port: config.port });
// Socket.IO only on request (REALTIME=true): the desk polls, and nothing else connects
const closeRealtime = config.realtime
  ? attachRealtime(app.server, { db, databaseUrl: config.databaseUrl, corsOrigins: config.corsOrigins, log: app.log })
  : async () => {};

const shutdown = async () => {
  app.log.info("stopping");
  await closeRealtime();
  await app.close();
  // Best effort: the last queued lines (at most 3 s), then its own pool
  await opsLog.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
