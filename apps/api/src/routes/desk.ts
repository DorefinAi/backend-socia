// The X console: queue, draft, claim, edit, approve, undo, reject, recall.

import {
  DRAFT_STATUSES, PHASE_OFF_MESSAGE, REJECT_REASONS, STORY_LINK_DAYS, assemblePostText, checkXPost, istDayRange, istDayStart, parseLinkSlug, storyLinkName, xLen, X_LIMIT,
} from "@socia/core";
import {
  approveDraft, assets, capUsage, cardState, claimDraft, clearCustomCard, copyPosted, extendClaim, ingestedFiles, markPosted, postDrafts, postedView, publishedPosts,
  rejectDraft, releaseDraft, requestCardRender, requestRecall, restoreDraft, retryFailed, setCustomCard, stories, undoCopyPosted, undoPost, updateDraft,
  users, type Actor,
} from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { HttpError, guard, requirePermission, type SessionUser } from "../auth";
import { jpegSize, pngSize } from "../image-size";
import type { AppDeps } from "../app";
import { ReporterHandles } from "../handle-keywords";
import { NOT_A_CHECK, breakingFields, cardUrl, draftView, storyLabels } from "../views";

const actor = (u: SessionUser): Actor => ({ id: u.id, orgId: u.orgId, name: u.name, role: u.role });
const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

/** view=posted: a draft's newest post record (who, when, the undo window) and exactly what went out */
type PostedRecord = Omit<ReturnType<typeof postedView>, "undoUntil"> & {
  /** The Copy & Posted undo deadline; null when the record shown was recalled (nothing left to undo) */
  undoUntil: Date | null;
  text: string;
  cardUrl: string | null;
  permalink: string | null;
  publishedAt: Date;
  publishedBy: string | null;
  manual: boolean;
  copied: boolean;
  recalled: { at: Date; reason: string | null } | null;
};

/** Holding a draft is the first step of every desk action, so any one of them allows a claim. */
const CLAIM = ["draft.edit", "draft.card", "post.publish", "post.mark_posted", "draft.reject"] as const;

/** X takes images up to 5 MB */
export const CARD_MAX_BYTES = 5 * 1024 * 1024;
const CARD_MIN_PX = 300;
const CARD_MAX_PX = 4096;
const CARD_CONTENT_TYPE = { jpg: "image/jpeg", png: "image/png" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "<ISO time>|<draft id>" (what nextCursor gives) or a bare ISO time; anything else is a 400 */
export function parseQueueCursor(value: string | undefined): { at: Date; id: string | null } | null {
  if (!value) return null;
  const [time, id] = value.split("|");
  const at = new Date(time ?? "");
  if (Number.isNaN(at.getTime()) || (id !== undefined && !UUID.test(id))) throw new HttpError(400, "invalid", "This page link is not valid. Reload the list.");
  return { at, id: id ?? null };
}

/** A post's address on X; the id is the last path part. Query and fragment (?s=20) are allowed. */
export const X_PERMALINK = /^https:\/\/(www\.)?(x|twitter)\.com\/\w{1,15}\/status\/(\d{5,25})(?:[/?#]\S*)?$/;

const VersionQuery = Type.Object({ version: Type.Integer() });

const QUEUE_VIEWS = {
  inbox: ["ready", "claimed"],
  sending: ["queued", "publishing"],
  rejected: ["rejected"],
  failed: ["failed", "render_failed"],
  /** Marked posted (Copy & Posted, or a recorded manual / API post), newest first */
  posted: ["published"],
} as const;
type QueueViewName = keyof typeof QUEUE_VIEWS;
const ViewName = Type.Union(Object.keys(QUEUE_VIEWS).map((k) => Type.Literal(k)));

/** The phase-1 filters (handoff/phase1-contract.md §1); all optional, combined with AND */
const QueueFilters = {
  /** English district as in item.district; "none" for stories without one */
  district: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  big: Type.Optional(Type.Boolean()),
  update: Type.Optional(Type.Boolean()),
  desk: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2,10}$" })),
  needsCheck: Type.Optional(Type.Boolean()),
};

/** `day` ("YYYY-MM-DD", an India calendar day, not in the future) as [start, end); anything else is a 400 bad_day */
export function parseQueueDay(value: string | undefined, now = new Date()): { start: Date; end: Date } | null {
  if (value === undefined) return null;
  const range = istDayRange(value);
  if (!range) throw new HttpError(400, "bad_day", "The day must be a real date written as YYYY-MM-DD.");
  if (range.start > istDayStart(now)) throw new HttpError(400, "bad_day", "The day cannot be in the future (India time).");
  return range;
}

/** The posted view's window: from the start of the IST day `days - 1` days back */
function postedSince(days: number): Date {
  return new Date(istDayStart(new Date()).getTime() - (days - 1) * 24 * 60 * 60 * 1000);
}

/** WHERE parts for the filters, on the joined stories row */
function filterWhere(q: { district?: string; big?: boolean; update?: boolean; desk?: string; needsCheck?: boolean }): (SQL | undefined)[] {
  // Compared as text: a hand-edited or malformed value never makes the cast fail the whole query
  const flag = (key: "big" | "update", on: boolean) => (on ? sql`(${stories.fileTags}->>${key}) = 'true'` : sql`(${stories.fileTags}->>${key}) IS DISTINCT FROM 'true'`);
  return [
    q.district === undefined ? undefined : q.district === "none" ? isNull(stories.district) : eq(stories.district, q.district),
    q.big === undefined ? undefined : flag("big", q.big),
    q.update === undefined ? undefined : flag("update", q.update),
    q.desk === undefined ? undefined : sql`${stories.fileTags}->>'desk' = ${q.desk.toUpperCase()}`,
    // A removed desk note is recorded but is not a reason to check the story
    q.needsCheck === undefined
      ? undefined
      : q.needsCheck
        ? sql`cardinality(array_remove(${stories.needsCheck}, ${NOT_A_CHECK})) > 0`
        : sql`cardinality(array_remove(${stories.needsCheck}, ${NOT_A_CHECK})) = 0`,
  ];
}

export const deskRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, storage, config }) => {
  /** The desk's own reporters (apps/worker/config/reporter-handles.json), re-read when the file changes */
  const reporters = new ReporterHandles(app.log);

  /** Phase 1 posts by hand: nothing that would reach the X API is accepted */
  const xApiOff = () => {
    if (config.phase === 1) throw new HttpError(409, "phase_off", PHASE_OFF_MESSAGE);
  };

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
          view: Type.Optional(ViewName),
          /** A nextCursor from the previous page ("<time>|<id>"), or an ISO time (older clients) */
          before: Type.Optional(Type.String({ maxLength: 80 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          /** view=posted only: how many IST days back, today included (default 1 = today) */
          days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
          /** Only stories received (stories.created_at) on this India calendar day, "YYYY-MM-DD"; checked in the handler (400 bad_day) */
          day: Type.Optional(Type.String({ maxLength: 40 })),
          ...QueueFilters,
        }),
      },
    },
    async (req) => {
      const { user } = guard(req);
      const day = parseQueueDay(req.query.day);
      const viewName = (req.query.view ?? "inbox") as QueueViewName;
      // Rejected and posted page by when that happened (the draft's last change); the other views by when it was made
      const sortCol = viewName === "rejected" || viewName === "posted" ? postDrafts.updatedAt : postDrafts.createdAt;
      const cursor = parseQueueCursor(req.query.before);
      const limit = req.query.limit ?? 100;
      const rows = await db
        .select({
          id: postDrafts.id,
          status: postDrafts.status,
          version: postDrafts.version,
          bodyText: postDrafts.bodyText,
          hashtags: postDrafts.hashtags,
          mentions: postDrafts.mentions,
          cardRev: postDrafts.cardRev,
          cardRenderedRev: postDrafts.cardRenderedRev,
          renderedKey: postDrafts.cardKey,
          customCardKey: postDrafts.customCardKey,
          renderError: postDrafts.renderError,
          town: stories.town,
          fileTags: stories.fileTags,
          needsCheck: stories.needsCheck,
          deskNote: stories.deskNote,
          updateOfDraftId: stories.updateOfDraftId,
          cardKey: sql<string | null>`coalesce(${postDrafts.customCardKey}, ${postDrafts.cardKey})`,
          claimedBy: postDrafts.claimedBy,
          claimExpiresAt: postDrafts.claimExpiresAt,
          holder: users.name,
          rejectReason: postDrafts.rejectReason,
          rejectNote: postDrafts.rejectNote,
          createdAt: postDrafts.createdAt,
          sortAt: sortCol,
          slug: stories.slug,
          source: stories.source,
          district: stories.district,
          external: stories.external,
          mediaState: stories.mediaState,
          images: sql<number>`(SELECT count(*)::int FROM ${assets} WHERE ${assets.storyId} = ${stories.id} AND ${assets.kind} = 'image')`,
          videos: sql<number>`(SELECT count(*)::int FROM ${assets} WHERE ${assets.storyId} = ${stories.id} AND ${assets.kind} = 'video')`,
          headline: stories.headline,
          /** The story's points, one per line: the card text (bodyText is the tweet) */
          storyBody: stories.body,
          receivedAt: stories.createdAt,
          sourcePath: ingestedFiles.sourcePath,
          lowConfidence: sql<boolean>`coalesce(${stories.conversionConfidence} < 0.97, false)`,
          needsReview: sql<boolean>`${stories.parseMethod} = 'needs_review'`,
        })
        .from(postDrafts)
        .innerJoin(stories, eq(stories.id, postDrafts.storyId))
        // The original file's path, org-scoped; no row for Samvadia / Web Scraper stories
        .leftJoin(ingestedFiles, and(eq(ingestedFiles.id, stories.fileId), eq(ingestedFiles.orgId, postDrafts.orgId)))
        .leftJoin(users, eq(users.id, postDrafts.claimedBy))
        .where(
          and(
            eq(postDrafts.orgId, user.orgId),
            eq(postDrafts.platform, "x"),
            inArray(postDrafts.status, [...QUEUE_VIEWS[viewName]]),
            cursor?.id ? sql`(${sortCol}, ${postDrafts.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined,
            cursor && !cursor.id ? lt(sortCol, cursor.at) : undefined,
            viewName === "posted" ? gte(postDrafts.updatedAt, postedSince(req.query.days ?? 1)) : undefined,
            day ? gte(stories.createdAt, day.start) : undefined,
            day ? lt(stories.createdAt, day.end) : undefined,
            ...filterWhere(req.query),
          ),
        )
        .orderBy(desc(sortCol), desc(postDrafts.id))
        .limit(limit);
      const last = rows.at(-1);
      const nextCursor = rows.length === limit && last ? `${last.sortAt.toISOString()}|${last.id}` : null;

      const now = new Date();
      const posted = viewName === "posted" ? await postedBy(user.orgId, rows.map((r) => r.id)) : new Map<string, PostedRecord>();
      return {
        cap: await capUsage(db, user.orgId),
        nextCursor,
        items: await Promise.all(
          rows.map(async (r) => {
            const held = r.status === "claimed" && !!r.claimExpiresAt && r.claimExpiresAt > now;
            const text = assemblePostText(r.bodyText, r.hashtags, r.mentions);
            return {
              id: r.id,
              status: held || r.status !== "claimed" ? r.status : "ready",
              version: r.version,
              slug: r.slug,
              /** The story's name for the editor link (?story=) and downloaded files, instead of the draft id */
              ...storyLinkName({ district: r.district, headline: r.headline, receivedAt: r.receivedAt }),
              headline: r.headline,
              bodyText: r.bodyText,
              storyBody: r.storyBody ?? "",
              receivedAt: r.receivedAt,
              createdAt: r.createdAt,
              /** The original file's path (ingested_files.source_path); null when the story has no file */
              sourcePath: r.sourcePath ?? null,
              source: r.source,
              district: r.district,
              ...storyLabels(r.external),
              media: { images: r.images, videos: r.videos, state: r.mediaState },
              cardUrl: await cardUrl(storage, r.cardKey),
              claim: held ? { userId: r.claimedBy, name: r.holder, until: r.claimExpiresAt, mine: r.claimedBy === user.id } : null,
              rejectReason: r.rejectReason,
              rejectNote: r.rejectNote,
              flags: { lowConfidence: r.lowConfidence, needsReview: r.needsReview },
              ...breakingFields({ town: r.town, fileTags: r.fileTags, needsCheck: r.needsCheck, deskNote: r.deskNote }),
              /** Exactly what Copy & Posted copies, and its X length */
              postText: text,
              length: xLen(text),
              card: { state: cardState({ cardRev: r.cardRev, cardRenderedRev: r.cardRenderedRev, cardKey: r.renderedKey, customCardKey: r.customCardKey, renderError: r.renderError }) },
              posted: posted.get(r.id) ?? null,
              /** A file saved again after its post went out: the posted draft this one updates */
              updateOfDraftId: r.updateOfDraftId,
            };
          }),
        ),
      };
    },
  );

  /**
   * The posted view's post record for each draft: who marked it posted and when (with the Copy & Posted undo
   * window), and exactly what went out. One query: per draft, a LATERAL pick of its newest published_posts row
   * (published_posts_draft_idx), a live record ahead of a recalled one.
   */
  async function postedBy(orgId: string, draftIds: string[]) {
    const out = new Map<string, PostedRecord>();
    if (!draftIds.length) return out;
    const newest = db
      .select({
        text: publishedPosts.text,
        cardKey: publishedPosts.cardKey,
        permalink: publishedPosts.permalink,
        publishedAt: publishedPosts.publishedAt,
        publishedBy: publishedPosts.publishedBy,
        byName: sql<string | null>`${users.name}`.as("by_name"),
        manual: publishedPosts.manual,
        recalledAt: publishedPosts.recalledAt,
        recallReason: publishedPosts.recallReason,
      })
      .from(publishedPosts)
      .leftJoin(users, eq(users.id, publishedPosts.publishedBy))
      .where(and(eq(publishedPosts.draftId, postDrafts.id), eq(publishedPosts.orgId, orgId)))
      .orderBy(sql`${publishedPosts.recalledAt} IS NOT NULL`, desc(publishedPosts.publishedAt))
      .limit(1)
      .as("newest_post");
    const rows = await db
      .select({
        draftId: postDrafts.id,
        text: newest.text,
        permalink: newest.permalink,
        publishedAt: newest.publishedAt,
        publishedBy: newest.publishedBy,
        byName: newest.byName,
        manual: newest.manual,
        recalledAt: newest.recalledAt,
        recallReason: newest.recallReason,
        // The card that went out; rows from before it was recorded fall back to the draft's rendered card (as GET /posts)
        cardKey: sql<string | null>`coalesce(${newest.cardKey}, ${postDrafts.cardKey})`,
      })
      .from(postDrafts)
      .innerJoinLateral(newest, sql`true`)
      .where(and(eq(postDrafts.orgId, orgId), inArray(postDrafts.id, draftIds)));
    await Promise.all(
      rows.map(async ({ draftId, cardKey, ...p }) => {
        out.set(draftId, {
          ...postedView({ at: p.publishedAt, byId: p.publishedBy, byName: p.byName }),
          // Only recalled records left: the post is gone from X, so there is no undo window to offer
          ...(p.recalledAt && { undoUntil: null }),
          /** Exactly the text that went out */
          text: p.text,
          cardUrl: await cardUrl(storage, cardKey),
          permalink: p.permalink,
          publishedAt: p.publishedAt,
          /** The marker's name, as GET /posts returns it; null when unknown */
          publishedBy: p.byName,
          manual: p.manual,
          /** Copy & Posted: pasted on X by hand, no link recorded */
          copied: p.manual && !p.permalink,
          recalled: p.recalledAt ? { at: p.recalledAt, reason: p.recallReason } : null,
        });
      }),
    );
    return out;
  }

  /** Numbers for the filter dropdowns over a whole view (no paging); the posted view counts today (IST) only */
  app.get("/x/queue/facets", { schema: { querystring: Type.Object({ view: Type.Optional(ViewName) }) } }, async (req) => {
    const { user } = guard(req);
    const viewName = (req.query.view ?? "inbox") as QueueViewName;
    const scope = and(
      eq(postDrafts.orgId, user.orgId),
      eq(postDrafts.platform, "x"),
      inArray(postDrafts.status, [...QUEUE_VIEWS[viewName]]),
      viewName === "posted" ? gte(postDrafts.updatedAt, postedSince(1)) : undefined,
    );
    const desk = sql<string | null>`${stories.fileTags}->>'desk'`;
    // The desk's headline numbers are for stories received today (IST); the full view stays in `total`
    const receivedToday = gte(stories.createdAt, istDayStart(new Date()));
    const [[totals], districts, desks] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          big: sql<number>`(count(*) FILTER (WHERE ${and(...filterWhere({ big: true }))}))::int`,
          update: sql<number>`(count(*) FILTER (WHERE ${and(...filterWhere({ update: true }))}))::int`,
          needsCheck: sql<number>`(count(*) FILTER (WHERE ${and(...filterWhere({ needsCheck: true }))}))::int`,
          todayTotal: sql<number>`(count(*) FILTER (WHERE ${receivedToday}))::int`,
          todayNeedsCheck: sql<number>`(count(*) FILTER (WHERE ${and(receivedToday, ...filterWhere({ needsCheck: true }))}))::int`,
        })
        .from(postDrafts)
        .innerJoin(stories, eq(stories.id, postDrafts.storyId))
        .where(scope),
      db
        .select({ name: stories.district, n: sql<number>`count(*)::int` })
        .from(postDrafts)
        .innerJoin(stories, eq(stories.id, postDrafts.storyId))
        .where(scope)
        .groupBy(stories.district)
        .orderBy(desc(count()), stories.district),
      db
        .select({ code: desk, n: sql<number>`count(*)::int` })
        .from(postDrafts)
        .innerJoin(stories, eq(stories.id, postDrafts.storyId))
        .where(and(scope, sql`${desk} IS NOT NULL`))
        .groupBy(desk)
        .orderBy(desc(count())),
    ]);
    return {
      districts: districts.map((d) => ({ name: d.name, n: Number(d.n) })),
      desks: desks.map((d) => ({ code: d.code, n: Number(d.n) })),
      big: Number(totals?.big ?? 0),
      update: Number(totals?.update ?? 0),
      needsCheck: Number(totals?.needsCheck ?? 0),
      total: Number(totals?.total ?? 0),
      /** Stories received today (IST, from midnight) in this view: the desk's "To post" and "Needs check" */
      today: { total: Number(totals?.todayTotal ?? 0), needsCheck: Number(totals?.todayNeedsCheck ?? 0) },
    };
  });

  app.get("/drafts/:id", { schema: { params: Id } }, async (req) => view(guard(req).user, req.params.id));

  /**
   * A story link (?story=<linkSlug>) back to its draft id: { id }, or 404 not_found. The slug ends in the story's
   * received time (HHMM IST), so only the org's drafts received at that hour and minute in the last STORY_LINK_DAYS (30) days (and with
   * or without a district, as the slug says) are named again; the newest exact match wins.
   */
  app.get(
    "/drafts/resolve",
    { schema: { querystring: Type.Object({ story: Type.String({ pattern: "^[a-z0-9-]{3,120}$" }) }) } },
    async (req) => {
      const { user } = guard(req);
      const slug = req.query.story;
      const notFound = () => new HttpError(404, "not_found", `This story link does not match a story. It may be older than ${STORY_LINK_DAYS} days.`);
      const parsed = parseLinkSlug(slug);
      if (!parsed) throw notFound();
      const istAt = sql`(${stories.createdAt} AT TIME ZONE 'Asia/Kolkata')`;
      const rows = await db
        .select({ id: postDrafts.id, district: stories.district, headline: stories.headline, receivedAt: stories.createdAt })
        .from(stories)
        .innerJoin(postDrafts, and(eq(postDrafts.storyId, stories.id), eq(postDrafts.orgId, stories.orgId)))
        .where(
          and(
            eq(stories.orgId, user.orgId),
            eq(postDrafts.platform, "x"),
            gte(stories.createdAt, sql`now() - make_interval(days => ${STORY_LINK_DAYS})`),
            sql`extract(hour from ${istAt}) = ${parsed.hour}`,
            sql`extract(minute from ${istAt}) = ${parsed.minute}`,
            // "news-…" is a story without a district (or one whose district has no Latin letters to name it by)
            parsed.noDistrict ? undefined : sql`${stories.district} IS NOT NULL`,
          ),
        )
        .orderBy(desc(stories.createdAt), desc(postDrafts.createdAt))
        .limit(200);
      const hit = rows.find((r) => storyLinkName(r).linkSlug === slug);
      if (!hit) throw notFound();
      return { id: hit.id };
    },
  );

  app.post("/drafts/:id/claim", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, CLAIM, "x");
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
      requirePermission(user, "draft.edit", "x");
      const { version, ...patch } = req.body;
      // The desk's reporter list: a reporter's handle may be added without a directory row, and adding
      // one teaches us the file-name token it belongs to (packages/db desk.ts learnReporterTokens)
      await updateDraft(db, actor(user), req.params.id, version, patch, { reporterHandles: await reporters.handles() });
      return view(user, req.params.id);
    },
  );

  // ─── Custom card ───────────────────────────────────────────────────────────
  // The X desk edits the card in the browser and sends it as the raw body: JPEG (the format cards go out
  // in) or PNG (what older desk builds send). The type is read from the bytes, and the file is stored
  // under a key with the matching extension and content type, so a card is always served as what it is.
  // The image parsers live only in this child scope, so no other route accepts an image body.
  await app.register(async (scope) => {
    const cards = scope.withTypeProvider<TypeBoxTypeProvider>();
    cards.addContentTypeParser(["image/jpeg", "image/png"], { parseAs: "buffer", bodyLimit: CARD_MAX_BYTES }, (_req, body, done) => done(null, body));

    cards.put("/drafts/:id/card", { bodyLimit: CARD_MAX_BYTES, schema: { params: Id, querystring: VersionQuery } }, async (req) => {
      const { user } = guard(req);
      requirePermission(user, "draft.card", "x");
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, "unsupported_type", "Send the card as a JPEG or PNG image (content-type: image/jpeg or image/png).");
      if (body.length > CARD_MAX_BYTES) throw new HttpError(413, "too_large", "The card is over 5 MB, the most X accepts.");
      const png = pngSize(body);
      const jpeg = png === null ? jpegSize(body) : null;
      const size = png ?? jpeg;
      if (size === null) throw new HttpError(415, "unsupported_type", "This file is not a JPEG or PNG image.");
      if (size === "no_header") throw new HttpError(400, "invalid", `This ${png ? "PNG" : "JPEG"} has no readable image header.`);
      const { width, height } = size;
      if ([width, height].some((n) => n < CARD_MIN_PX || n > CARD_MAX_PX)) {
        throw new HttpError(400, "invalid", `The card must be ${CARD_MIN_PX} to ${CARD_MAX_PX} pixels on each side; this one is ${width}x${height}.`);
      }
      const format = png ? "png" : "jpg";
      await setCustomCard(db, actor(user), req.params.id, req.query.version, { bytes: body.length, width, height }, (key) => storage.put(key, body, CARD_CONTENT_TYPE[format]), format);
      return view(user, req.params.id);
    });

    cards.delete("/drafts/:id/card", { schema: { params: Id, querystring: VersionQuery } }, async (req) => {
      const { user } = guard(req);
      requirePermission(user, "draft.card", "x");
      await clearCustomCard(db, actor(user), req.params.id, req.query.version);
      return view(user, req.params.id);
    });
  });

  /** The operator posted on X by hand (e.g. X was down for the API): record it as published. */
  app.post(
    "/drafts/:id/mark-posted",
    { schema: { params: Id, body: Type.Object({ version: Type.Integer(), permalink: Type.String({ maxLength: 500 }) }) } },
    async (req) => {
      const { user } = guard(req);
      requirePermission(user, "post.mark_posted", "x");
      const permalink = req.body.permalink.trim();
      const match = X_PERMALINK.exec(permalink);
      if (!match) throw new HttpError(400, "invalid", "Paste the post's link from X, like https://x.com/<account>/status/<number>.");
      const post = await markPosted(db, actor(user), req.params.id, req.body.version, { platformPostId: match[3]!, permalink });
      return { postId: post.id, permalink: post.permalink };
    },
  );

  /**
   * Copy & Posted (phase 1): the desk copied postText and pasted it on X by hand. Records who and when, no
   * permalink; can be taken back for COPY_UNDO_SECONDS by the same person (or anyone allowed to undo posts).
   */
  app.post("/drafts/:id/copy-posted", { schema: { params: Id, body: Type.Object({ version: Type.Integer() }) } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "post.mark_posted", "x");
    return copyPosted(db, actor(user), req.params.id, req.body.version);
  });

  app.post("/drafts/:id/copy-posted/undo", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, ["post.mark_posted", "post.undo"], "x");
    const draft = await undoCopyPosted(db, actor(user), req.params.id, user.permissions.has("post.undo"));
    return view(user, draft.id);
  });

  /** "Add card": phase-1 drafts have no card until someone asks; the render worker draws it (202, then draft.updated) */
  app.post("/drafts/:id/card/render", { schema: { params: Id } }, async (req, reply) => {
    const { user } = guard(req);
    requirePermission(user, "draft.card", "x");
    await requestCardRender(db, actor(user), req.params.id);
    return reply.status(202).send(await view(user, req.params.id));
  });

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
    xApiOff();
    requirePermission(user, "post.publish", "x");
    const { job } = await approveDraft(db, actor(user), req.params.id, req.body.version);
    return { jobId: job.id, sendAt: job.nextAttemptAt };
  });

  app.post("/jobs/:id/undo", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "post.undo", "x");
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
      requirePermission(user, ["draft.reject", "post.publish"], "x");
      await rejectDraft(db, actor(user), req.params.id, req.body.reason, req.body.note ?? null);
      return { ok: true };
    },
  );

  app.post("/drafts/:id/restore", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "story.take_in", "x");
    await restoreDraft(db, actor(user), req.params.id);
    return view(user, req.params.id);
  });

  app.post("/drafts/:id/retry", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    xApiOff();
    requirePermission(user, "post.publish", "x");
    const job = await retryFailed(db, actor(user), req.params.id);
    return { jobId: job.id };
  });

  app.get("/caps", async (req) => ({ x: await capUsage(db, guard(req).user.orgId) }));

  /** Tab badges and dashboard tiles: drafts per status and per queue view, posts today, the cap. */
  app.get("/x/counts", async (req) => {
    const { user } = guard(req);
    const rows = await db
      .select({
        status: sql<string>`CASE WHEN ${postDrafts.status} = 'claimed' AND (${postDrafts.claimExpiresAt} IS NULL OR ${postDrafts.claimExpiresAt} <= now()) THEN 'ready' ELSE ${postDrafts.status} END`,
        n: count(),
      })
      .from(postDrafts)
      .where(and(eq(postDrafts.orgId, user.orgId), eq(postDrafts.platform, "x")))
      .groupBy(sql`1`);
    const byStatus = Object.fromEntries(DRAFT_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.n);
    const byView = Object.fromEntries(Object.entries(QUEUE_VIEWS).map(([v, statuses]) => [v, statuses.reduce((a, s) => a + (byStatus[s] ?? 0), 0)]));
    const [today] = await db
      .select({ n: count() })
      .from(publishedPosts)
      .where(and(eq(publishedPosts.orgId, user.orgId), eq(publishedPosts.platform, "x"), gte(publishedPosts.publishedAt, istDayStart(new Date()))));
    return { byStatus, byView, publishedToday: Number(today?.n ?? 0), cap: await capUsage(db, user.orgId) };
  });

  // ─── Published ─────────────────────────────────────────────────────────────

  app.get(
    "/posts",
    { schema: { querystring: Type.Object({ before: Type.Optional(Type.String({ format: "date-time" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) } },
    async (req) => {
      const { user } = guard(req);
      const rows = await db
        .select({
          p: publishedPosts,
          by: users.name,
          // The card that went out; rows from before it was recorded fall back to the draft's rendered card
          cardKey: sql<string | null>`coalesce(${publishedPosts.cardKey}, ${postDrafts.cardKey})`,
          headline: stories.headline,
          slug: stories.slug,
        })
        .from(publishedPosts)
        .leftJoin(users, eq(users.id, publishedPosts.publishedBy))
        .leftJoin(postDrafts, eq(postDrafts.id, publishedPosts.draftId))
        .leftJoin(stories, eq(stories.id, postDrafts.storyId))
        .where(and(eq(publishedPosts.orgId, user.orgId), req.query.before ? lt(publishedPosts.publishedAt, new Date(req.query.before)) : undefined))
        .orderBy(desc(publishedPosts.publishedAt))
        .limit(req.query.limit ?? 50);
      return {
        items: await Promise.all(rows.map(async ({ p, by, cardKey, headline, slug }) => ({
          id: p.id,
          draftId: p.draftId,
          platform: p.platform,
          text: p.text,
          permalink: p.permalink,
          publishedAt: p.publishedAt,
          publishedBy: by,
          recalled: p.recalledAt ? { at: p.recalledAt, reason: p.recallReason } : null,
          cardUrl: await cardUrl(storage, cardKey),
          headline,
          slug,
          manual: p.manual,
          /** Copy & Posted: pasted on X by hand, no link recorded */
          copied: p.manual && !p.permalink,
        }))),
      };
    },
  );

  app.post(
    "/posts/:id/recall",
    { schema: { params: Id, body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 500 }) }) } },
    async (req) => {
      const { user } = guard(req);
      xApiOff();
      requirePermission(user, "post.undo", "x");
      const job = await requestRecall(db, actor(user), req.params.id, req.body.reason);
      return { jobId: job.id };
    },
  );
};
