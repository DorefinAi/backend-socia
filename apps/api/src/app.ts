// The HTTP API. It only reads and writes rows: it never calls X and never renders (spec §5).

import { createReadStream } from "node:fs";
import { extname } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { PaceStore } from "@socia/core";
import { DeskError, type Db } from "@socia/db";
import { LocalStorage, type Storage, type WebGet } from "@socia/providers";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyServerOptions } from "fastify";
import { COOKIE, HttpError, loadSession } from "./auth";
import { ownerKeyFrom, type ApiConfig } from "./config";
import { adminRoutes } from "./routes/admin";
import { authRoutes, type AuthLimits } from "./routes/auth";
import { deskRoutes } from "./routes/desk";
import { libraryRoutes } from "./routes/library";
import { ownerRoutes, type OwnerLimits } from "./routes/owner";
import { statusRoutes } from "./routes/status";
import { templateRoutes } from "./routes/templates";
import { trendRoutes } from "./routes/trends";

export interface AppDeps {
  db: Db;
  storage: Storage;
  config: ApiConfig;
  /** Reads from the free public web sources (Web Scraper); tests pass recorded fixtures */
  web?: WebGet;
  /** Pacing for GDELT and the slow sources; default: shared with the worker through the kv table */
  pace?: PaceStore;
  /** Sign-in throttling (routes/auth.ts); tests pass small numbers. Default: AUTH_LIMITS */
  authLimits?: Partial<AuthLimits>;
  /** Owner API failure limit (routes/owner.ts); tests pass small numbers. Default: OWNER_LIMITS */
  ownerLimits?: Partial<OwnerLimits>;
}

/**
 * Request schemas are strict: an object schema that does not say otherwise gets additionalProperties: false,
 * so an unknown key is a 400 instead of slipping through to a handler (mass assignment). Applies to every
 * body, querystring and params schema of every route, including ones that forget to say so. Members of an
 * allOf (Type.Intersect) are left alone, since each member only knows its own keys.
 */
export function strictSchema<T>(schema: T): T {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const src = schema as Record<string, unknown>;
  // Keep TypeBox's own (non-enumerable) markers: copy every property descriptor
  const out = Object.create(Object.getPrototypeOf(src), Object.getOwnPropertyDescriptors(src)) as Record<string, unknown>;
  const set = (key: string, value: unknown) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  if (src.type === "object" && src.properties && typeof src.properties === "object") {
    if (src.additionalProperties === undefined && src.patternProperties === undefined) set("additionalProperties", false);
    set("properties", Object.fromEntries(Object.entries(src.properties as Record<string, unknown>).map(([k, v]) => [k, strictSchema(v)])));
  }
  if (src.items) set("items", Array.isArray(src.items) ? src.items.map(strictSchema) : strictSchema(src.items));
  for (const key of ["anyOf", "oneOf"] as const) if (Array.isArray(src[key])) set(key, (src[key] as unknown[]).map(strictSchema));
  return out as T;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".mkv": "video/x-matroska",
};

export async function buildApp(deps: AppDeps, logger: FastifyServerOptions["logger"] = true) {
  // Only the configured proxies may set req.ip (the sign-in rate-limit key); default: the socket address
  // Fastify turns a bare hop count into "trust nothing" (fail closed), which behind a proxy would key every
  // user on the proxy's address; a count is given as a function instead: trust the first `n` hops
  // (the socket peer is hop 0). Safe only when clients cannot reach the API without the proxy (Render).
  const tp = deps.config.trustProxy;
  const trustProxy = typeof tp === "number" ? (_address: string, hop: number) => hop < tp : tp;
  const app = Fastify({ logger, trustProxy }).withTypeProvider<TypeBoxTypeProvider>();
  // Strict bodies, querystrings and params (headers always carry extra keys)
  app.setValidatorCompiler((route) => TypeBoxValidatorCompiler(route.httpPart === "headers" ? route : { ...route, schema: strictSchema(route.schema) }));

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
    // Body parser refusals (only the card and card-background uploads take a non-JSON body)
    if (e.statusCode === 413) return reply.status(413).send({ error: "too_large", message: "The upload is over 5 MB, the most X accepts." });
    if (e.statusCode === 415) return reply.status(415).send({ error: "unsupported_type", message: "This content type is not accepted here." });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: "bad_request", message: e.message });
    // A row this change points at was removed meanwhile (e.g. a role deleted while a user is given it)
    const pgCode = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23503") return reply.status(409).send({ error: "conflict", message: "Something this change refers to was just changed or removed. Reload and try again." });
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
  await app.register(statusRoutes, deps);
  await app.register(templateRoutes, deps);
  await app.register(trendRoutes, deps);
  // The owner console's API exists only with a long enough OWNER_API_KEY; otherwise every /owner path is a 404
  const ownerKey = ownerKeyFrom(deps.config.ownerApiKey ?? undefined);
  if (ownerKey) await app.register(ownerRoutes, { ...deps, ownerKey });
  return app;
}
