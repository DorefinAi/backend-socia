// The HTTP API. It only reads and writes rows: it never calls X and never renders (spec §5).

import { createReadStream } from "node:fs";
import { extname } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { DeskError, type Db } from "@socia/db";
import { LocalStorage, type Storage } from "@socia/providers";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyServerOptions } from "fastify";
import { COOKIE, HttpError, loadSession } from "./auth";
import type { ApiConfig } from "./config";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { deskRoutes } from "./routes/desk";
import { libraryRoutes } from "./routes/library";

export interface AppDeps {
  db: Db;
  storage: Storage;
  config: ApiConfig;
}

const CONTENT_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".txt": "text/plain; charset=utf-8" };

export async function buildApp(deps: AppDeps, logger: FastifyServerOptions["logger"] = true) {
  const app = Fastify({ logger, trustProxy: true }).withTypeProvider<TypeBoxTypeProvider>();
  app.setValidatorCompiler(TypeBoxValidatorCompiler);

  await app.register(cookie);
  await app.register(cors, {
    origin: deps.config.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["content-type", "x-csrf"],
  });

  app.decorateRequest("session", null);
  app.addHook("preHandler", async (req) => {
    req.session = await loadSession(deps.db, req.cookies[COOKIE]);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DeskError) return reply.status(err.status).send({ error: err.code, message: err.message, ...err.data });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.status(400).send({ error: "invalid", message: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: "bad_request", message: e.message });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "server", message: "Something went wrong on our side. Try again in a moment." });
  });

  app.get("/healthz", async () => {
    await deps.db.execute(sql`select 1`);
    return { ok: true };
  });

  // Development: serve the local storage folder (cards, raw files) in place of signed R2 links
  if (deps.storage instanceof LocalStorage) {
    const local = deps.storage;
    app.get("/dev-files/*", async (req, reply) => {
      const key = decodeURIComponent((req.params as { "*": string })["*"]);
      const path = local.resolveKey(key);
      reply.type(CONTENT_TYPES[extname(path)] ?? "application/octet-stream");
      return reply.send(createReadStream(path));
    });
  }

  await app.register(authRoutes, deps);
  await app.register(deskRoutes, deps);
  await app.register(libraryRoutes, deps);
  await app.register(adminRoutes, deps);
  return app;
}
