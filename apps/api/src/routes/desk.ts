// The X console: queue, draft, claim, edit, approve, undo, reject, recall.

import { REJECT_REASONS, assemblePostText, checkXPost, X_LIMIT } from "@socia/core";
import {
  approveDraft, capUsage, claimDraft, extendClaim, postDrafts, postMetrics, publishedPosts, rejectDraft, releaseDraft,
  requestRecall, restoreDraft, retryFailed, stories, undoPost, updateDraft, users, type Actor,
} from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { HttpError, guard, requireAct, type SessionUser } from "../auth";
import type { AppDeps } from "../app";
import { cardUrl, draftView } from "../views";

const actor = (u: SessionUser): Actor => ({ id: u.id, orgId: u.orgId, name: u.name, role: u.role });
const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

const QUEUE_VIEWS = {
  inbox: ["ready", "claimed"],
  sending: ["queued", "publishing"],
  rejected: ["rejected"],
  failed: ["failed", "render_failed"],
} as const;

export const deskRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, storage }) => {
  async function loadDraft(orgId: string, id: string) {
    const [row] = await db
      .select({ d: postDrafts, s: stories })
      .from(postDrafts)
      .innerJoin(stories, eq(stories.id, postDrafts.storyId))
      .where(and(eq(postDrafts.id, id), eq(postDrafts.orgId, orgId)));
    if (!row) throw new HttpError(404, "not_found", "This draft does not exist.");
    return row;
  }

  async function view(user: SessionUser, id: string) {
    const { d, s } = await loadDraft(user.orgId, id);
    return draftView(db, storage, d, s, user.id);
  }

  app.get(
    "/x/queue",
    {
      schema: {
        querystring: Type.Object({
          view: Type.Optional(Type.Union(Object.keys(QUEUE_VIEWS).map((k) => Type.Literal(k)))),
          before: Type.Optional(Type.String({ format: "date-time" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
      },
    },
    async (req) => {
      const { user } = guard(req);
      const viewName = (req.query.view ?? "inbox") as keyof typeof QUEUE_VIEWS;
      const rows = await db
        .select({
          id: postDrafts.id,
          status: postDrafts.status,
          version: postDrafts.version,
          bodyText: postDrafts.bodyText,
          cardKey: postDrafts.cardKey,
          claimedBy: postDrafts.claimedBy,
          claimExpiresAt: postDrafts.claimExpiresAt,
          holder: users.name,
          rejectReason: postDrafts.rejectReason,
          createdAt: postDrafts.createdAt,
          slug: stories.slug,
          headline: stories.headline,
          receivedAt: stories.createdAt,
          lowConfidence: sql<boolean>`coalesce(${stories.conversionConfidence} < 0.97, false)`,
          needsReview: sql<boolean>`${stories.parseMethod} = 'needs_review'`,
        })
        .from(postDrafts)
        .innerJoin(stories, eq(stories.id, postDrafts.storyId))
        .leftJoin(users, eq(users.id, postDrafts.claimedBy))
        .where(
          and(
            eq(postDrafts.orgId, user.orgId),
            eq(postDrafts.platform, "x"),
            inArray(postDrafts.status, [...QUEUE_VIEWS[viewName]]),
            req.query.before ? lt(postDrafts.createdAt, new Date(req.query.before)) : undefined,
          ),
        )
        .orderBy(desc(postDrafts.createdAt))
        .limit(req.query.limit ?? 100);

      const now = new Date();
      return {
        cap: await capUsage(db, user.orgId),
        items: await Promise.all(
          rows.map(async (r) => {
            const held = r.status === "claimed" && !!r.claimExpiresAt && r.claimExpiresAt > now;
            return {
              id: r.id,
              status: held || r.status !== "claimed" ? r.status : "ready",
              version: r.version,
              slug: r.slug,
              headline: r.headline,
              bodyText: r.bodyText,
              receivedAt: r.receivedAt,
              cardUrl: await cardUrl(storage, r.cardKey),
              claim: held ? { userId: r.claimedBy, name: r.holder, until: r.claimExpiresAt, mine: r.claimedBy === user.id } : null,
              rejectReason: r.rejectReason,
              flags: { lowConfidence: r.lowConfidence, needsReview: r.needsReview },
            };
          }),
        ),
      };
    },
  );

  app.get("/drafts/:id", { schema: { params: Id } }, async (req) => view(guard(req).user, req.params.id));

  app.post("/drafts/:id/claim", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requireAct(user);
    await claimDraft(db, actor(user), req.params.id);
    return view(user, req.params.id);
  });

  app.post("/drafts/:id/heartbeat", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    return { until: await extendClaim(db, actor(user), req.params.id) };
  });

  app.post("/drafts/:id/release", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    await releaseDraft(db, actor(user), req.params.id);
    return { ok: true };
  });

  app.patch(
    "/drafts/:id",
    {
      schema: {
        params: Id,
        body: Type.Object({
          version: Type.Integer(),
          bodyText: Type.Optional(Type.String({ maxLength: 2000 })),
          cardHeadline: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
          hashtags: Type.Optional(Type.Array(Type.String({ pattern: "^#\\S+$" }), { maxItems: 10 })),
          mentions: Type.Optional(Type.Array(Type.String({ pattern: "^@\\w{1,15}$" }), { maxItems: 5 })),
        }),
      },
    },
    async (req) => {
      const { user } = guard(req);
      requireAct(user);
      const { version, ...patch } = req.body;
      await updateDraft(db, actor(user), req.params.id, version, patch);
      return view(user, req.params.id);
    },
  );

  /** The live counter while typing: same rules as approve, no database. */
  app.post(
    "/x/check",
    { schema: { body: Type.Object({ bodyText: Type.String(), hashtags: Type.Array(Type.String()), mentions: Type.Array(Type.String()) }) } },
    async (req) => {
      guard(req);
      const text = assemblePostText(req.body.bodyText, req.body.hashtags, req.body.mentions);
      const check = checkXPost(text);
      return { text, length: check.length, limit: X_LIMIT, problems: check.problems };
    },
  );

  app.post("/drafts/:id/approve", { schema: { params: Id, body: Type.Object({ version: Type.Integer() }) } }, async (req) => {
    const { user } = guard(req);
    requireAct(user);
    const { job } = await approveDraft(db, actor(user), req.params.id, req.body.version);
    return { jobId: job.id, sendAt: job.nextAttemptAt };
  });

  app.post("/jobs/:id/undo", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requireAct(user);
    const draft = await undoPost(db, actor(user), req.params.id);
    return view(user, draft.id);
  });

  app.post(
    "/drafts/:id/reject",
    {
      schema: {
        params: Id,
        body: Type.Object({ reason: Type.Union(REJECT_REASONS.map((r) => Type.Literal(r))), note: Type.Optional(Type.String({ maxLength: 500 })) }),
      },
    },
    async (req) => {
      const { user } = guard(req);
      requireAct(user);
      await rejectDraft(db, actor(user), req.params.id, req.body.reason, req.body.note ?? null);
      return { ok: true };
    },
  );

  app.post("/drafts/:id/restore", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requireAct(user);
    await restoreDraft(db, actor(user), req.params.id);
    return view(user, req.params.id);
  });

  app.post("/drafts/:id/retry", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requireAct(user);
    const job = await retryFailed(db, actor(user), req.params.id);
    return { jobId: job.id };
  });

  app.get("/caps", async (req) => ({ x: await capUsage(db, guard(req).user.orgId) }));

  // ─── Published ─────────────────────────────────────────────────────────────

  app.get(
    "/posts",
    { schema: { querystring: Type.Object({ before: Type.Optional(Type.String({ format: "date-time" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) } },
    async (req) => {
      const { user } = guard(req);
      const latest = db
        .selectDistinctOn([postMetrics.postId], {
          postId: postMetrics.postId,
          impressions: postMetrics.impressions,
          likes: postMetrics.likes,
          comments: postMetrics.comments,
          shares: postMetrics.shares,
          fetchedAt: postMetrics.fetchedAt,
        })
        .from(postMetrics)
        .orderBy(postMetrics.postId, desc(postMetrics.fetchedAt))
        .as("latest");
      const rows = await db
        .select({
          p: publishedPosts,
          by: users.name,
          m: { postId: latest.postId, impressions: latest.impressions, likes: latest.likes, comments: latest.comments, shares: latest.shares, fetchedAt: latest.fetchedAt },
        })
        .from(publishedPosts)
        .leftJoin(users, eq(users.id, publishedPosts.publishedBy))
        .leftJoin(latest, eq(latest.postId, publishedPosts.id))
        .where(and(eq(publishedPosts.orgId, user.orgId), req.query.before ? lt(publishedPosts.publishedAt, new Date(req.query.before)) : undefined))
        .orderBy(desc(publishedPosts.publishedAt))
        .limit(req.query.limit ?? 50);
      return {
        items: rows.map(({ p, by, m }) => ({
          id: p.id,
          draftId: p.draftId,
          platform: p.platform,
          text: p.text,
          permalink: p.permalink,
          publishedAt: p.publishedAt,
          publishedBy: by,
          recalled: p.recalledAt ? { at: p.recalledAt, reason: p.recallReason } : null,
          metrics: m?.postId ? { impressions: m.impressions, likes: m.likes, comments: m.comments, shares: m.shares, at: m.fetchedAt } : null,
        })),
      };
    },
  );

  app.post(
    "/posts/:id/recall",
    { schema: { params: Id, body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 500 }) }) } },
    async (req) => {
      const { user } = guard(req);
      requireAct(user);
      const job = await requestRecall(db, actor(user), req.params.id, req.body.reason);
      return { jobId: job.id };
    },
  );
};
