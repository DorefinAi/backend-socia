// Source health for the dashboard: what the ingest worker last did, and what came in today.

import { istDayStart } from "@socia/core";
import { assets, readIngestStatus, stories } from "@socia/db";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, count, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { guard } from "../auth";
import type { AppDeps } from "../app";

export const statusRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db }) => {
  app.get("/ingest/status", async (req) => {
    const { user } = guard(req);
    const status = await readIngestStatus(db);
    const dayStart = istDayStart(new Date());

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

    return {
      mode: status?.mode ?? null,
      lastPollAt: status?.lastPollAt ?? null,
      lastOkAt: status?.lastOkAt ?? null,
      lastError: status?.lastError ?? null,
      cursor: status?.cursor ?? null,
      today: {
        stories: Number(storiesToday?.n ?? 0),
        storiesFailed: Number(failed?.n ?? 0),
        storiesWithoutFootagePath: Number(footageMissing?.n ?? 0),
        mediaCopied: media?.copied ?? 0,
        mediaSkipped: media?.skipped ?? 0,
      },
      mediaWaiting: Number(waiting?.n ?? 0),
      recentErrors: status?.recentErrors ?? [],
    };
  });
};
