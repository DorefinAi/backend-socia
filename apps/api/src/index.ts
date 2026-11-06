import { createDb, recordApiPhase, type DbLogger } from "@socia/db";
import { buildApp } from "./app";
import { loadConfig, makeStorage } from "./config";
import { attachRealtime } from "./realtime";

// Until Fastify's logger exists, the console. A crash is logged and the process exits non-zero so the
// supervisor starts it again; nothing tries to carry on in an unknown state.
let log: DbLogger & { fatal: (obj: object, msg: string) => void } = {
  error: (obj, msg) => console.error(msg, obj),
  fatal: (obj, msg) => console.error(msg, obj),
};
process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "unhandled promise rejection; exiting");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception; exiting");
  process.exit(1);
});

const config = loadConfig();
// A dropped idle connection (Postgres restarted) is logged and replaced, not fatal
const { db, close } = createDb(config.databaseUrl, 10, { log: { error: (obj, msg) => log.error(obj, msg) } });
const app = await buildApp({ db, storage: makeStorage(config), config });
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
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
