// Post analytics (handoff/scraper-analytics-contract.md §B), editors and admins only. "Desk" is our own
// numbers from the desk's tables; "posts" and "insights" read the platform numbers the metrics worker
// captures. Every platform answer says whether its numbers are sample data ("fake") or the platform's.

import { POST_SORTS, deskAnalytics, postInsights, postsWithMetrics, sortPosts, type PostWithMetrics } from "@socia/db";
import { METRIC_PLATFORMS, metricsModes, type MetricPlatform, type MetricsMode } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { HttpError, guard, requireRole } from "../auth";
import type { AppDeps } from "../app";

export const ANALYTICS_DEFAULT_DAYS = 7;
export const ANALYTICS_MAX_DAYS = 92;

const literals = <T extends string>(list: readonly T[]) => Type.Union(list.map((v) => Type.Literal(v)));

const Range = {
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
};

/** from/to as given, else the last 7 days to now; at most 92 days */
export function analyticsRange(q: { from?: string; to?: string }, now = new Date()): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - ANALYTICS_DEFAULT_DAYS * 86400_000);
  if (!(from < to)) throw new HttpError(400, "invalid", "The start of the period must be before its end.");
  if (to.getTime() - from.getTime() > ANALYTICS_MAX_DAYS * 86400_000) throw new HttpError(400, "invalid", `Pick a period of at most ${ANALYTICS_MAX_DAYS} days.`);
  return { from, to };
}

/** Configured mode per platform, shown as "fake" whenever any number in the answer for it is sample data */
export function answerModes(posts: PostWithMetrics[], configured = metricsModes()): Record<MetricPlatform, MetricsMode> {
  const out = { ...configured };
  for (const p of posts) if (p.mode === "fake" && METRIC_PLATFORMS.includes(p.platform as MetricPlatform)) out[p.platform as MetricPlatform] = "fake";
  return out;
}

export const analyticsRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db }) => {
  const editor = (req: Parameters<typeof guard>[0]) => {
    const { user } = guard(req);
    requireRole(user, "editor", "admin");
    return user;
  };

  app.get("/analytics/desk", { schema: { querystring: Type.Object(Range) } }, async (req) => {
    const user = editor(req);
    const { from, to } = analyticsRange(req.query);
    return { from: from.toISOString(), to: to.toISOString(), ...(await deskAnalytics(db, user.orgId, from, to)) };
  });

  app.get(
    "/analytics/posts",
    {
      schema: {
        querystring: Type.Object({
          ...Range,
          platform: Type.Optional(literals(METRIC_PLATFORMS)),
          sort: Type.Optional(literals(POST_SORTS)),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
      },
    },
    async (req) => {
      const user = editor(req);
      const { from, to } = analyticsRange(req.query);
      const posts = await postsWithMetrics(db, user.orgId, from, to, req.query.platform);
      const modes = answerModes(posts);
      return {
        from: from.toISOString(), to: to.toISOString(), total: posts.length,
        items: sortPosts(posts, req.query.sort ?? "impressions").slice(0, req.query.limit ?? 50),
        modes, ...(req.query.platform ? { mode: modes[req.query.platform] } : {}),
      };
    },
  );

  app.get(
    "/analytics/insights",
    { schema: { querystring: Type.Object({ ...Range, platform: Type.Optional(literals(METRIC_PLATFORMS)) }) } },
    async (req) => {
      const user = editor(req);
      const { from, to } = analyticsRange(req.query);
      const posts = await postsWithMetrics(db, user.orgId, from, to, req.query.platform);
      const modes = answerModes(posts);
      return {
        from: from.toISOString(), to: to.toISOString(), posts: posts.length, ...postInsights(posts),
        modes, ...(req.query.platform ? { mode: modes[req.query.platform] } : {}),
      };
    },
  );
};
