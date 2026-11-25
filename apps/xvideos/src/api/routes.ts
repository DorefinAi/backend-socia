// The X Videos desk's routes, as a Fastify plugin the api mounts with one line (apps/api/src/app.ts, only when
// XVIDEOS=true). Read only for now: the clips found on the video share, one clip, its video (streamed from the share,
// with seeking), its poster and its stills (from the local cache). The api hands in its own sign-in check and error
// type, so this folder needs nothing else from the api.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { Db } from "@socia/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { xvGetClip, xvListClips } from "../db/clips";
import { XV_CLIP_STATUSES, type XvClipStatus } from "../db/schema";
import { xvWireClip } from "./view";

export interface XvRouteOptions {
  db: Db;
  /** The api's sign-in and permission check for viewing the desk: the viewer's org, or it throws */
  viewer: (req: FastifyRequest) => { orgId: string };
  /** The api's own error type, so its error handler answers as for every other route */
  httpError: (status: number, code: string, message: string) => Error;
  /** The video share (read only) and the local cache; default XVIDEOS_SHARE / XVIDEOS_CACHE */
  shareRoot?: string;
  cacheDir?: string;
}

const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".mpg": "video/mpeg" };
/** A still's file name in the cache: letters, digits, dot, dash, underscore, ending .jpg */
const STILL_NAME = /^[\w.-]{1,80}\.jpg$/;

const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

/** `child` under `root`, or null: a stored path can never reach outside its folder */
function inside(root: string, ...parts: string[]): string | null {
  const base = resolve(root);
  const full = resolve(base, ...parts);
  return full !== base && !full.startsWith(base + sep) ? null : full;
}

type HttpErrorOf = XvRouteOptions["httpError"];

/** Sends a file, honouring one "bytes=a-b" range so the player can seek */
async function sendFile(reply: FastifyReply, httpError: HttpErrorOf, path: string | null, type: string, range: string | undefined) {
  if (!path) throw httpError(404, "not_found", "No such file.");
  let size: number;
  try {
    // A hung share answers nothing at all: give up after 10 s rather than hold the request
    size = (await Promise.race([stat(path), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000))])).size;
  } catch {
    throw httpError(404, "not_found", "The file is not on the share any more (renamed or moved). Reload the list.");
  }
  reply.header("accept-ranges", "bytes").header("cache-control", "private, max-age=60").header("x-content-type-options", "nosniff").type(type);
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (!m[1] && !m[2])) return reply.header("content-length", size).send(createReadStream(path));
  let start = m[1] ? Number(m[1]) : Math.max(size - Number(m[2]), 0);
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return reply.status(416).header("content-range", `bytes */${size}`).send();
  start = Math.max(start, 0);
  end = Math.max(end, start);
  return reply
    .status(206)
    .header("content-range", `bytes ${start}-${end}/${size}`)
    .header("content-length", end - start + 1)
    .send(createReadStream(path, { start, end }));
}

export const xvideosRoutes: FastifyPluginAsyncTypebox<XvRouteOptions> = async (app, opts) => {
  const { db, viewer, httpError } = opts;
  const shareRoot = opts.shareRoot ?? process.env.XVIDEOS_SHARE ?? "";
  const cacheDir = opts.cacheDir ?? process.env.XVIDEOS_CACHE ?? "";
  if (!shareRoot || !cacheDir) throw new Error("X Videos routes need XVIDEOS_SHARE and XVIDEOS_CACHE");

  app.get(
    "/xvideos/clips",
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(Type.String({ maxLength: 80 })),
          since: Type.Optional(Type.String({ format: "date-time" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
      },
    },
    async (req) => {
      const user = viewer(req);
      const statuses = req.query.status?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      const bad = statuses.filter((s) => !XV_CLIP_STATUSES.includes(s as XvClipStatus));
      if (bad.length) throw httpError(400, "invalid", `Unknown status: ${bad.join(", ")}.`);
      const rows = await xvListClips(db, user.orgId, {
        statuses: statuses.length ? (statuses as XvClipStatus[]) : ["seen", "reading", "new", "failed"],
        since: req.query.since ? new Date(req.query.since) : new Date(Date.now() - 48 * 3600_000),
        limit: req.query.limit,
      });
      return { clips: rows.map((c) => xvWireClip(c, null, false)) };
    },
  );

  app.get("/xvideos/clips/:id", { schema: { params: Id } }, async (req) => {
    const user = viewer(req);
    const found = await xvGetClip(db, user.orgId, req.params.id);
    if (!found) throw httpError(404, "not_found", "No such clip.");
    return { clip: xvWireClip(found.clip, found.evidence, true) };
  });

  app.get("/xvideos/clips/:id/video", { schema: { params: Id } }, async (req, reply) => {
    const user = viewer(req);
    const found = await xvGetClip(db, user.orgId, req.params.id);
    if (!found) throw httpError(404, "not_found", "No such clip.");
    const path = inside(shareRoot, ...found.clip.folder, found.clip.fileName);
    return sendFile(reply, httpError, path, VIDEO_TYPES[extname(path ?? "").toLowerCase()] ?? "application/octet-stream", req.headers.range);
  });

  app.get("/xvideos/clips/:id/poster", { schema: { params: Id } }, async (req, reply) => {
    const user = viewer(req);
    const found = await xvGetClip(db, user.orgId, req.params.id);
    if (!found?.clip.posterKey) throw httpError(404, "not_found", "No poster yet.");
    return sendFile(reply, httpError, inside(cacheDir, found.clip.posterKey), "image/jpeg", undefined);
  });

  app.get(
    "/xvideos/clips/:id/frames/:name",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String({ maxLength: 84 }) }) } },
    async (req, reply) => {
      const user = viewer(req);
      if (!STILL_NAME.test(req.params.name)) throw httpError(404, "not_found", "No such still.");
      const found = await xvGetClip(db, user.orgId, req.params.id);
      if (!found) throw httpError(404, "not_found", "No such clip.");
      return sendFile(reply, httpError, inside(cacheDir, "frames", found.clip.id, req.params.name), "image/jpeg", undefined);
    },
  );
};
