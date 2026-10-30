// Source health for the dashboard: what the ingest worker last did, and what came in today.
//
// Everyone sees a plain state ("share unreachable", "today's folder not made yet", counts, how old the newest
// file is). Server paths, file names, errno codes, error texts and the error list are for people with the
// Settings permission only: a path on the newsroom share says more about the network than a desk needs.

import { istDayStart } from "@socia/core";
import { assets, readDataFileStatus, readIngestStatus, stories, type IngestStatus } from "@socia/db";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, count, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { guard } from "../auth";
import type { AppDeps } from "../app";

export type SourceState = "ok" | "share_unreachable" | "folder_missing" | "data_file_problem" | "error" | "not_polled";

/** One word for the desk's health light */
export function sourceState(status: IngestStatus | null, dataOk: boolean): SourceState {
  if (!status) return "not_polled";
  if (status.source && !status.source.reachable) return "share_unreachable";
  if (!dataOk) return "data_file_problem";
  if (status.lastError && status.lastError.at === status.lastPollAt) return "error";
  if (status.source && !status.source.todayFolder) return "folder_missing";
  return "ok";
}

export const statusRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, config }) => {
  app.get("/ingest/status", async (req) => {
    const { user } = guard(req);
    const detail = user.permissions.has("page.settings");
    const status = await readIngestStatus(db);
    const dataFiles = await readDataFileStatus(db);
    const dataOk = dataFiles.every((f) => f.ok);
    const now = new Date();
    const dayStart = istDayStart(now);

    const [storiesToday] = await db.select({ n: count() }).from(stories).where(and(eq(stories.orgId, user.orgId), gte(stories.createdAt, dayStart)));
    const [media] = await db
      .select({
        copied: sql<number>`count(*) FILTER (WHERE ${assets.storageKey} IS NOT NULL)::int`,
        skipped: sql<number>`count(*) FILTER (WHERE ${assets.storageKey} IS NULL)::int`,
      })
      .from(assets)
      .where(and(eq(assets.orgId, user.orgId), gte(assets.createdAt, dayStart)));
    const [waiting] = await db.select({ n: count() }).from(stories).where(and(eq(stories.orgId, user.orgId), eq(stories.mediaState, "awaiting")));
    const [failed] = await db.select({ n: count() }).from(stories).where(and(eq(stories.orgId, user.orgId), eq(stories.status, "failed"), gte(stories.createdAt, dayStart)));
    const [footageMissing] = await db
      .select({ n: count() })
      .from(stories)
      .where(and(eq(stories.orgId, user.orgId), eq(stories.source, "samvadia"), isNotNull(stories.external), isNull(sql`${stories.external}->>'footagePath'`), gte(stories.createdAt, dayStart)));

    const src = status?.source ?? null;
    const lastFileAgeSeconds = src?.lastFileAt ? Math.max(0, Math.round((now.getTime() - Date.parse(src.lastFileAt)) / 1000)) : null;
    const state = sourceState(status, dataOk);

    return {
      phase: config.phase ?? 2,
      state,
      mode: status?.mode ?? null,
      lastPollAt: status?.lastPollAt ?? null,
      lastOkAt: status?.lastOkAt ?? null,
      // The error text may name a server or path: plain words for everyone but Settings users
      lastError: !status?.lastError ? null : detail ? status.lastError : { at: status.lastError.at, message: "The source could not be read." },
      cursor: status?.cursor ?? null,
      today: {
        stories: Number(storiesToday?.n ?? 0),
        storiesFailed: Number(failed?.n ?? 0),
        storiesWithoutFootagePath: Number(footageMissing?.n ?? 0),
        mediaCopied: media?.copied ?? 0,
        mediaSkipped: media?.skipped ?? 0,
      },
      mediaWaiting: Number(waiting?.n ?? 0),
      recentErrors: detail ? (status?.recentErrors ?? []) : [],
      /** The breaking-files share (phase 1); null for other sources. Folder and file names for Settings users only */
      source: !src
        ? null
        : {
            kind: src.kind,
            reachable: src.reachable,
            expectedFolder: src.expectedFolder,
            todayFolderFound: !!src.todayFolder,
            filesToday: src.filesToday,
            lastFileAt: src.lastFileAt,
            lastFileAgeSeconds,
            checkedAt: src.checkedAt,
            ...(detail
              ? { todayFolder: src.todayFolder, alsoScanning: src.alsoScanning, lastFileName: src.lastFileName, lastError: src.lastError }
              : { todayFolder: null, alsoScanning: null, lastFileName: null, lastError: src.lastError ? { at: src.lastError.at, message: "The share cannot be read." } : null }),
          },
      /** The worker's places / handles files: readable or not (the reason for Settings users) */
      dataFiles: detail ? dataFiles : dataFiles.map((f) => ({ file: f.file, ok: f.ok, at: f.at })),
    };
  });
};
