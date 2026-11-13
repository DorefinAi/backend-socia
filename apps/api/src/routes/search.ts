// Story search for the desk's header bar: Hindi, Roman Hindi or English (core search.ts; story_search, migration 0025).

import { STORY_LINK_DAYS, expandQuery, searchSnippet, storyLinkName } from "@socia/core";
import { SEARCH_TIMEOUT_MS, SearchTimeoutError, searchStories } from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox, type Static } from "@fastify/type-provider-typebox";
import { HttpError, guard } from "../auth";
import type { AppDeps } from "../app";
import { SlidingLimiter } from "../limiter";

/** Per user, per minute */
export const STORY_SEARCHES_PER_MINUTE = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const StorySearchItemSchema = Type.Object({
  /** stories.id */
  id: Type.String(),
  headline: Nullable(Type.String()),
  /** ~140 characters of the body around the first matched word ("…" where cut), else the body's start */
  snippet: Nullable(Type.String()),
  /** English */
  district: Nullable(Type.String()),
  /** Hindi */
  town: Nullable(Type.String()),
  /** The story's X post draft's status (post_drafts.status; the newest X draft when there are several) */
  status: Type.String(),
  /** ISO; stories.created_at */
  receivedAt: Type.String(),
  /** The story link (GET /drafts/resolve); null when the story is older than STORY_LINK_DAYS (resolve cannot open it) */
  linkSlug: Nullable(Type.String()),
  match: Type.Union([Type.Literal("text"), Type.Literal("phonetic"), Type.Literal("translated")]),
});

export const StorySearchResponseSchema = Type.Object({
  items: Type.Array(StorySearchItemSchema),
  /** Hindi / English forms the query was expanded to beyond what was typed; [] when none */
  expanded: Type.Array(Type.String()),
});

export type StorySearchItem = Static<typeof StorySearchItemSchema>;
export type StorySearchResponse = Static<typeof StorySearchResponseSchema>;

const SearchQuery = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 100 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const searchRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, searchTimeoutMs }) => {
  const searches = new SlidingLimiter(STORY_SEARCHES_PER_MINUTE, 60_000);
  app.addHook("onClose", async () => searches.close());

  /** The org's desk stories (those with an X post draft), any status, best match first (each word must match: AND) */
  app.get(
    "/search/stories",
    { schema: { querystring: SearchQuery, response: { 200: StorySearchResponseSchema } } },
    async (req): Promise<StorySearchResponse> => {
      // Deliberately guard() only, like GET /x/queue: any verified user of the org may search its desk stories
      const { user } = guard(req);
      if (!searches.take(user.id)) throw new HttpError(429, "rate_limited", `Up to ${STORY_SEARCHES_PER_MINUTE} searches a minute. Wait a moment and try again.`);
      const { words } = expandQuery(req.query.q);
      const expanded = [...new Set(words.flatMap((w) => w.expanded))];
      if (!words.length) return { items: [], expanded };
      let rows;
      try {
        rows = await searchStories(db, user.orgId, words, req.query.limit ?? 20, searchTimeoutMs ?? SEARCH_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof SearchTimeoutError) throw new HttpError(503, "search_timeout", "That search took too long. Add another word to narrow it.");
        throw err;
      }
      const linkSince = Date.now() - STORY_LINK_DAYS * DAY_MS;
      return {
        items: rows.map((r) => ({
          id: r.id,
          headline: r.headline,
          snippet: searchSnippet(r.body, words),
          district: r.district,
          town: r.town,
          status: r.draftStatus,
          receivedAt: r.createdAt.toISOString(),
          linkSlug: r.createdAt.getTime() >= linkSince ? storyLinkName({ district: r.district, headline: r.headline, receivedAt: r.createdAt }).linkSlug : null,
          match: r.match,
        })),
        expanded,
      };
    },
  );
};
