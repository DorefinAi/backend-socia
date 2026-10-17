import { createDb } from "@socia/db";
import { buildApp } from "./app";
import { loadConfig, makeStorage } from "./config";
import { attachRealtime } from "./realtime";

const config = loadConfig();
const { db, close } = createDb(config.databaseUrl, 10);
const app = await buildApp({ db, storage: makeStorage(config), config });

await app.listen({ host: "0.0.0.0", port: config.port });
const closeRealtime = attachRealtime(app.server, { db, databaseUrl: config.databaseUrl, corsOrigins: config.corsOrigins, log: app.log });

const shutdown = async () => {
  app.log.info("stopping");
  await closeRealtime();
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
