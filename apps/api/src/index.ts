import { createDb, recordApiPhase } from "@socia/db";
import { buildApp } from "./app";
import { loadConfig, makeStorage } from "./config";
import { attachRealtime } from "./realtime";

const config = loadConfig();
const { db, close } = createDb(config.databaseUrl, 10);
const app = await buildApp({ db, storage: makeStorage(config), config });
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
