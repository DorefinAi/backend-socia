// The X Videos desk's routes, as a Fastify plugin the api mounts with one line (apps/api/src/app.ts, only when
// XVIDEOS=true): one day folder's clips, the day folders for the desk's selector, the Refresh button (asks the
// watcher to walk a day now), one clip, its video (streamed from the share, with seeking), its poster and its stills
// (from the local cache). The api hands in its own sign-in check and error
// type, so this folder needs nothing else from the api.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { Db } from "@socia/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { xvDecide, xvGetClip, xvListClips, xvListDays, xvRequestScan, xvSaveDraft, xvSetHold, xvUndoDecision, type XvActor, type XvDayCount, type XvListedClip } from "../db/clips";
import { xvLearnedDir } from "../worker/learn";
import { XV_CLIP_STATUSES, type XvClipStatus } from "../db/schema";
import { xvDayDate, xvToday } from "../share/rules";
import { XV_DIRECTORY_FILES, XvComposer } from "../compose/compose";
import { xvComposeInput, xvWireClip } from "./view";

const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/** "2026-11-27" names a real date (not "2026-02-31") */
const isRealDay = (day: string) => xvDayDate(day.split("-").reverse().join("-")) === day;

/** Days (newest first) grouped by month ("2026-11"), with today added in its place when it has no videos yet */
export function xvGroupDays(today: string, counts: readonly XvDayCount[]): { month: string; days: XvDayCount[] }[] {
  const days = counts.some((c) => c.day === today) ? [...counts] : [...counts, { day: today, clips: 0, picked: 0, done: 0 }];
  days.sort((a, b) => b.day.localeCompare(a.day));
  const months: { month: string; days: XvDayCount[] }[] = [];
  for (const d of days) {
    const month = d.day.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.month === month) last.days.push(d);
    else months.push({ month, days: [d] });
  }
  return months;
}

export interface XvRouteOptions {
  db: Db;
  /**
   * The api's sign-in and permission check for the desk: the viewer's org, and who they are (recorded on drafts, holds,
   * posts and rejects), or it throws. `need`: the X desk's permission an action needs besides viewing.
   */
  viewer: (req: FastifyRequest, need?: XvPermission) => { orgId: string; userId?: string; userName?: string };
  /** The api's own error type, so its error handler answers as for every other route */
  httpError: (status: number, code: string, message: string) => Error;
  /** The video share (read only) and the local cache; default XVIDEOS_SHARE / XVIDEOS_CACHE */
  shareRoot?: string;
  cacheDir?: string;
  /** The composer of step 5; default: the directory in apps/xvideos/directory and apps/worker/config */
  composer?: XvComposer;
}

const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".mpg": "video/mpeg" };
/** A still's file name in the cache: letters, digits, dot, dash, underscore, ending .jpg */
const STILL_NAME = /^[\w.-]{1,80}\.jpg$/;

const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

/** Copy & Mark Posted can be undone this long (the desk's UNDO_MS, 5 min, and a minute for a slow click) */
export const XV_UNDO_S = 6 * 60;

/** The X desk's permissions the video desk's actions use, as its own desk does (apps/api routes/desk.ts) */
export type XvPermission = "draft.edit" | "post.mark_posted" | "post.undo" | "draft.reject";

/** A hashtag or @handle: one word after its mark (no spaces or line breaks) */
const TAG_PATTERN = "^[#@][^\\s#@]{1,139}$";
const Part = Type.Object({ value: Type.String({ pattern: TAG_PATTERN }), on: Type.Boolean(), added: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
/** The editor's draft as the desk keeps it (frontend deskState.ts XvDraft) */
const Draft = Type.Object(
  {
    title: Type.String({ maxLength: 2000 }),
    source: Type.Optional(Type.Object({ kind: Type.String({ maxLength: 20 }), at: Type.Optional(Type.Number()) }, { additionalProperties: false })),
    brandOn: Type.Boolean(),
    hashtags: Type.Array(Part, { maxItems: 60 }),
    mentions: Type.Array(Part, { maxItems: 60 }),
    trim: Type.Object({ start: Type.Number({ minimum: 0 }), end: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
    savedAt: Type.Optional(Type.String({ maxLength: 40 })),
    scheduledAt: Type.Optional(Type.String({ maxLength: 40 })),
  },
  { additionalProperties: false },
);
const Tag = Type.String({ pattern: TAG_PATTERN });
/** Text with something in it besides spaces */
const Filled = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });

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

  // Step 5: the post around each headline, from the directory (reloaded when its files change, cached per clip state):
  // the one learn builds from the desk's posts (<XVIDEOS_CACHE>/directory) once it exists, else the committed one.
  // Loaded now, so a broken directory file shows in the log at start-up, not on the desk's first list.
  const learnedRoot = join(cacheDir, "directory");
  const videoDir = () => xvLearnedDir(learnedRoot) ?? XV_DIRECTORY_FILES.videoDir;
  const composer = opts.composer ?? new XvComposer(videoDir, undefined, undefined, undefined, (message) => app.log.warn(message));
  composer.directory();
  const compose = (input: ReturnType<typeof xvComposeInput>) => (input ? composer.compose(input) : null);
  const wire = (row: XvListedClip, evidence: Parameters<typeof xvWireClip>[1], withTranscript: boolean) =>
    xvWireClip(row, evidence, withTranscript, compose(xvComposeInput(row.clip, row.screenHeadline, row.screenResult)));

  // One day folder's videos, all of them (x-marked or not). Without `day`: today's (IST) only, never yesterday's.
  app.get(
    "/xvideos/clips",
    {
      schema: {
        querystring: Type.Object({
          day: Type.Optional(Type.String({ pattern: DAY_PATTERN })),
          status: Type.Optional(Type.String({ maxLength: 80 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        }),
      },
    },
    async (req) => {
      const user = viewer(req);
      const day = req.query.day ?? xvToday(new Date());
      if (!isRealDay(day)) throw httpError(400, "invalid", `Not a date: ${day}.`);
      const statuses = req.query.status?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      const bad = statuses.filter((s) => !XV_CLIP_STATUSES.includes(s as XvClipStatus));
      if (bad.length) throw httpError(400, "invalid", `Unknown status: ${bad.join(", ")}.`);
      const rows = await xvListClips(db, user.orgId, {
        day,
        statuses: statuses.length ? (statuses as XvClipStatus[]) : ["seen", "reading", "new", "failed"],
        limit: req.query.limit,
      });
      return { day, clips: rows.map((r) => wire(r, null, false)) };
    },
  );

  // The desk's month / day selector: the day folders that hold videos now, and today (always, even before its folder
  // exists), newest first, grouped by month
  app.get("/xvideos/folders", async (req) => {
    const user = viewer(req);
    const today = xvToday(new Date());
    return { today, months: xvGroupDays(today, await xvListDays(db, user.orgId)) };
  });

  // The desk's Refresh button: the watcher walks this day folder (?day=, default today) within seconds, then once more so
  // new files settle. No body. The list itself is read as usual (GET /xvideos/clips).
  app.post(
    "/xvideos/rescan",
    { schema: { querystring: Type.Object({ day: Type.Optional(Type.String({ pattern: DAY_PATTERN })) }) } },
    async (req) => {
      const user = viewer(req);
      const day = req.query.day ?? xvToday(new Date());
      if (!isRealDay(day)) throw httpError(400, "invalid", `Not a date: ${day}.`);
      await xvRequestScan(db, user.orgId, day);
      return { day, requested: true };
    },
  );

  app.get("/xvideos/clips/:id", { schema: { params: Id } }, async (req) => {
    const user = viewer(req);
    const found = await xvGetClip(db, user.orgId, req.params.id);
    if (!found) throw httpError(404, "not_found", "No such clip.");
    return { clip: wire(found, found.evidence, true) };
  });

  // ─── step 6: the desk's actions. Each answers with the clip as the desk now shows it. ───

  /** The clip of the viewer's org (404 otherwise), checked for the action's permission, and who is acting */
  const target = async (req: FastifyRequest, id: string, need: XvPermission) => {
    const user = viewer(req, need);
    const found = await xvGetClip(db, user.orgId, id);
    if (!found) throw httpError(404, "not_found", "No such clip.");
    const by: XvActor = { id: user.userId ?? null, name: user.userName ?? null };
    return { user, found, by };
  };
  const fresh = async (orgId: string, id: string) => {
    const found = await xvGetClip(db, orgId, id);
    if (!found) throw httpError(404, "not_found", "No such clip.");
    return { clip: wire(found, found.evidence, false) };
  };

  /** Why a clip cannot take a new decision, draft or hold: one stands already, or the share says it was posted by hand */
  const decided = (found: XvListedClip): Error | null => {
    if (found.decision) {
      return httpError(
        409,
        "conflict",
        found.decision.action === "posted" ? `Already posted${found.decision.byName ? ` by ${found.decision.byName}` : ""}.` : "This clip was rejected; restore it first.",
      );
    }
    if (found.clip.done) return httpError(409, "conflict", "Already posted by hand (the file is marked done on the share).");
    return null;
  };
  /** After a decision lost a race: what stands now (a 404 when the clip went meanwhile) */
  const lost = async (orgId: string, id: string): Promise<Error> => {
    const now = await xvGetClip(db, orgId, id);
    if (!now) return httpError(404, "not_found", "No such clip.");
    return decided(now) ?? httpError(409, "conflict", "Someone else acted on this clip a moment ago; look again.");
  };

  // Save the editor's draft (the desk opens it instead of the suggestion); DELETE goes back to the suggestion
  app.put("/xvideos/clips/:id/draft", { schema: { params: Id, body: Type.Object({ draft: Draft }, { additionalProperties: false }) } }, async (req) => {
    const { user, found, by } = await target(req, req.params.id, "draft.edit");
    const d = req.body.draft;
    if (d.trim.end < d.trim.start) throw httpError(400, "invalid", "The trim ends before it starts.");
    const no = decided(found);
    if (no) throw no;
    await xvSaveDraft(db, user.orgId, req.params.id, d, by);
    return fresh(user.orgId, req.params.id);
  });
  app.delete("/xvideos/clips/:id/draft", { schema: { params: Id } }, async (req) => {
    const { user, by } = await target(req, req.params.id, "draft.edit");
    await xvSaveDraft(db, user.orgId, req.params.id, null, by);
    return fresh(user.orgId, req.params.id);
  });

  // Hold ("I'm on this one") or let go; anyone may take a hold over, the desk shows who holds it. A decided clip
  // cannot be held.
  app.post("/xvideos/clips/:id/hold", { schema: { params: Id, body: Type.Object({ held: Type.Boolean() }, { additionalProperties: false }) } }, async (req) => {
    const { user, found, by } = await target(req, req.params.id, "draft.edit");
    const no = req.body.held ? decided(found) : null;
    if (no) throw no;
    await xvSetHold(db, user.orgId, req.params.id, req.body.held, by);
    return fresh(user.orgId, req.params.id);
  });

  // Copy & Mark Posted: the text the editor copied to X
  app.post(
    "/xvideos/clips/:id/posted",
    {
      schema: {
        params: Id,
        body: Type.Object(
          {
            text: Filled(5000),
            title: Type.Optional(Type.String({ maxLength: 2000 })),
            hashtags: Type.Optional(Type.Array(Tag, { maxItems: 60 })),
            mentions: Type.Optional(Type.Array(Tag, { maxItems: 60 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { user, found, by } = await target(req, req.params.id, "post.mark_posted");
      const no = decided(found);
      if (no) throw no;
      if (found.clip.status === "gone") throw httpError(409, "conflict", "The file has left the share; it can no longer be posted.");
      const b = req.body;
      if (!(await xvDecide(db, user.orgId, req.params.id, { action: "posted", text: b.text, title: b.title ?? null, hashtags: b.hashtags ?? [], mentions: b.mentions ?? [] }, by))) {
        throw await lost(user.orgId, req.params.id);
      }
      return fresh(user.orgId, req.params.id);
    },
  );

  // Undo the post named (postId from the clip as the desk shows it) within XV_UNDO_S of it, as the desk's undo bar
  app.post("/xvideos/clips/:id/undo", { schema: { params: Id, body: Type.Object({ postId: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }) } }, async (req) => {
    const { user, by } = await target(req, req.params.id, "post.undo");
    const out = await xvUndoDecision(db, user.orgId, req.params.id, "posted", by, { postId: req.body.postId, withinS: XV_UNDO_S });
    if (out === "none") throw httpError(409, "conflict", "That post is not standing (already undone, or a newer one replaced it).");
    if (out === "too_late") throw httpError(409, "conflict", `A post can be undone for ${XV_UNDO_S / 60} minutes only; delete it on X and mark the clip again if needed.`);
    return fresh(user.orgId, req.params.id);
  });

  app.post(
    "/xvideos/clips/:id/reject",
    { schema: { params: Id, body: Type.Object({ reason: Filled(200) }, { additionalProperties: false }) } },
    async (req) => {
      const { user, found, by } = await target(req, req.params.id, "draft.reject");
      const no = decided(found);
      if (no) throw no;
      if (!(await xvDecide(db, user.orgId, req.params.id, { action: "rejected", reason: req.body.reason.trim() }, by))) {
        throw await lost(user.orgId, req.params.id);
      }
      return fresh(user.orgId, req.params.id);
    },
  );

  // A rejected clip back on the desk (any time)
  app.post("/xvideos/clips/:id/restore", { schema: { params: Id } }, async (req) => {
    const { user, by } = await target(req, req.params.id, "draft.reject");
    if ((await xvUndoDecision(db, user.orgId, req.params.id, "rejected", by)) === "none") throw httpError(409, "conflict", "This clip is not rejected.");
    return fresh(user.orgId, req.params.id);
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
