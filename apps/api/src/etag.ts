// ETag / 304 for the desk's polled reads (queue, facets, counts): an unchanged list costs a header, not the body.

import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A weak tag from the exact bytes sent: the same body always gets the same tag */
export function weakEtag(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

/** If-None-Match names this tag (weak comparison, a list, or "*") */
export function etagMatches(header: string | string[] | undefined, tag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, "");
  const want = opaque(tag);
  return [header].flat().join(",").split(",").some((t) => t.trim() === "*" || opaque(t) === want);
}

/**
 * Route-level onSend: on a 200 JSON reply, tags the body and asks the browser to check back every time
 * (private, no-cache); when the request already holds that tag, the reply becomes a 304 with no body.
 * Errors, other statuses and non-JSON replies pass through untouched.
 */
export async function etagOnSend(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (reply.statusCode !== 200 || typeof payload !== "string") return payload;
  if (!String(reply.getHeader("content-type") ?? "").startsWith("application/json")) return payload;
  const tag = weakEtag(payload);
  reply.header("etag", tag);
  reply.header("cache-control", "private, no-cache");
  if (!etagMatches(req.headers["if-none-match"], tag)) return payload;
  reply.code(304);
  reply.removeHeader("content-type");
  return "";
}
