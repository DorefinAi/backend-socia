// Tables: spec v1.1 §6.8 plus the Phase 1 additions in the backend architecture doc §10.
// org_id is on every table from day one: Socia is meant to run for more than one media house.

import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("org_id").notNull().references(() => orgs.id);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export interface OrgSettings {
  hashtagScript: "latin" | "devanagari";
  fixedHashtags: string[];
  maxHashtags: number;
  dailyCaps: { x: number };
  headlineWords: number;
}

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  settings: jsonb("settings").$type<OrgSettings>().notNull(),
  createdAt: createdAt(),
});

export const USER_ROLES = ["operator", "editor", "admin", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable(
  "users",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** AES-256-GCM, key from SECRET_KEY */
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    role: text("role").$type<UserRole>().notNull(),
    /** Operators see only these platforms */
    platforms: text("platforms").array().notNull().default(sql`'{x}'::text[]`),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    check("users_role_check", sql`${t.role} IN ('operator', 'editor', 'admin', 'viewer')`),
  ],
);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** sha256 of the cookie value; the value itself is never stored */
  tokenHash: text("token_hash").notNull().unique(),
  csrfToken: text("csrf_token").notNull(),
  /** False between password and TOTP */
  verified: boolean("verified").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// ─── Card templates ──────────────────────────────────────────────────────────

/** Where the desk draws on a user's card background. Positions are fractions (0..1) of the image. */
export interface CardLayout {
  date: { x: number; y: number; w: number; h: number; color: string; format: string };
  box: { x: number; y: number; w: number; h: number };
  headline: { color: string };
  body: { color: string };
  fontMinPx: number;
  fontMaxPx: number;
}

/** One background per user per platform, uploaded once; the desk draws each card on it in the browser. */
export const cardTemplates = pgTable(
  "card_templates",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().default("x"),
    backgroundKey: text("background_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    layout: jsonb("layout").$type<CardLayout>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("card_templates_user_platform_key").on(t.userId, t.platform)],
);

// ─── Ingest ──────────────────────────────────────────────────────────────────

export const FILE_KINDS = ["text", "image", "video", "other"] as const;

export const ingestedFiles = pgTable(
  "ingested_files",
  {
    id: id(),
    orgId: orgId(),
    sha256: text("sha256").notNull(),
    sourcePath: text("source_path").notNull(),
    fileName: text("file_name").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    mtime: timestamp("mtime", { withTimezone: true }),
    storageKey: text("storage_key").notNull(),
    kind: text("kind").$type<(typeof FILE_KINDS)[number]>().notNull(),
    slug: text("slug").notNull(),
    seq: integer("seq"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ingested_files_sha256_key").on(t.orgId, t.sha256), index("ingested_files_slug_idx").on(t.orgId, t.slug)],
);

export const STORY_STATUSES = ["ingested", "converted", "composed", "failed", "archived"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];
export const MEDIA_STATES = ["awaiting", "attached", "none"] as const;

/** Where a story's text came from: a file on the share/folder, or an approved story in Samvadia. */
/** file: the shared folder / FTP; samvadia: its database; trend: a Web Scraper item turned into a story */
export const STORY_SOURCES = ["file", "samvadia", "trend"] as const;
export type StorySource = (typeof STORY_SOURCES)[number];

/** What Samvadia told us about a story; shown on the draft, never edited here. */
export interface StoryExternal {
  storyId: string;
  itemId: string;
  version: number;
  kind: string;
  guid: string;
  title: string;
  reporter: string | null;
  districtCode: string | null;
  publishedAt: string;
  footagePath: string | null;
  footageStatus: string | null;
  /** Samvadia's item priority and category; absent on rows ingested before they were read (= normal / null) */
  priority?: "normal" | "high" | "breaking";
  category?: string | null;
}

export const stories = pgTable(
  "stories",
  {
    id: id(),
    orgId: orgId(),
    /** The text file; null for a story that came from Samvadia's database */
    fileId: uuid("file_id").references(() => ingestedFiles.id),
    source: text("source").$type<StorySource>().notNull().default("file"),
    /** Samvadia: "<story id>:v<version>", the dedupe key; null for files */
    externalId: text("external_id"),
    external: jsonb("external").$type<StoryExternal>(),
    /** District or city, for hashtags (Samvadia gives it; files do not) */
    district: text("district"),
    slug: text("slug").notNull(),
    status: text("status").$type<StoryStatus>().notNull().default("ingested"),
    /** The file as decoded, before Kruti Dev conversion, shown beside a low-confidence conversion */
    sourceText: text("source_text"),
    sourceCharset: text("source_charset"),
    sourceEncoding: text("source_encoding"),
    conversionConfidence: real("conversion_confidence"),
    headline: text("headline"),
    body: text("body"),
    parseMethod: text("parse_method"),
    parseNote: text("parse_note"),
    mediaState: text("media_state").$type<(typeof MEDIA_STATES)[number]>().notNull().default("awaiting"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("stories_status_idx").on(t.status, t.createdAt),
    index("stories_slug_idx").on(t.orgId, t.slug, t.createdAt),
    uniqueIndex("stories_external_key").on(t.orgId, t.source, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
    index("stories_source_recent_idx").on(t.source, t.createdAt),
  ],
);

/** Why a footage file was recorded but not copied into storage. */
export const MEDIA_SKIP_REASONS = ["video_off", "too_big"] as const;

export const assets = pgTable(
  "assets",
  {
    id: id(),
    orgId: orgId(),
    /** The ingested file; null for footage copied (or only recorded) straight from the FTP story folder */
    fileId: uuid("file_id").references(() => ingestedFiles.id),
    storyId: uuid("story_id").references(() => stories.id),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    seq: integer("seq"),
    /** Null when the file was recorded but not copied (see skipReason) */
    storageKey: text("storage_key"),
    /** "auto" by slug, "manual" from the attach picker, "footage" from the story's FTP folder */
    attachedBy: text("attached_by"),
    /** Footage only: where it is on the FTP, its name and size there */
    sourcePath: text("source_path"),
    fileName: text("file_name"),
    bytes: bigint("bytes", { mode: "number" }),
    skipReason: text("skip_reason").$type<(typeof MEDIA_SKIP_REASONS)[number]>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("assets_slug_idx").on(t.orgId, t.slug, t.createdAt),
    index("assets_story_idx").on(t.storyId),
    uniqueIndex("assets_story_source_path_key").on(t.storyId, t.sourcePath).where(sql`${t.sourcePath} IS NOT NULL`),
  ],
);

// ─── Drafts and publishing ───────────────────────────────────────────────────

export const postDrafts = pgTable(
  "post_drafts",
  {
    id: id(),
    orgId: orgId(),
    storyId: uuid("story_id").notNull().references(() => stories.id),
    platform: text("platform").notNull().default("x"),
    status: text("status").notNull().default("rendering"),
    /** Editable post text without the tag line */
    bodyText: text("body_text").notNull(),
    /** Text printed on the card */
    cardHeadline: text("card_headline").notNull(),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    /** Accepted by the operator */
    mentions: text("mentions").array().notNull().default(sql`'{}'::text[]`),
    /** {handleId, entity, handle, exact}[]; never posted until accepted */
    mentionSuggestions: jsonb("mention_suggestions").notNull().default(sql`'[]'::jsonb`),
    composeMethod: text("compose_method").notNull().default("rules"),
    composeVersion: text("compose_version").notNull(),
    /** Bumped on every card-text edit; the PNG is current when rendered_rev = card_rev */
    cardRev: integer("card_rev").notNull().default(1),
    cardRenderedRev: integer("card_rendered_rev").notNull().default(0),
    cardKey: text("card_key"),
    /** An operator-made card (edited in the browser). When set it is the card that gets posted. */
    customCardKey: text("custom_card_key"),
    cardFontPx: integer("card_font_px"),
    renderError: text("render_error"),
    /** Failed renders in a row; at the limit a new draft goes to render_failed instead of retrying forever */
    renderAttempts: integer("render_attempts").notNull().default(0),
    /** A render worker holds the draft until then; stops two workers drawing the same card */
    renderLeaseUntil: timestamp("render_lease_until", { withTimezone: true }),
    /** Optimistic concurrency: a stale version gets 409 */
    version: integer("version").notNull().default(1),
    claimedBy: uuid("claimed_by").references(() => users.id),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    rejectNote: text("reject_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("post_drafts_story_platform_key").on(t.storyId, t.platform),
    index("post_drafts_queue_idx").on(t.orgId, t.platform, t.status, t.createdAt),
    index("post_drafts_render_idx").on(t.cardRenderedRev, t.cardRev),
  ],
);

export const publishJobs = pgTable(
  "publish_jobs",
  {
    id: id(),
    orgId: orgId(),
    draftId: uuid("draft_id").notNull().references(() => postDrafts.id),
    /** post, or delete for a recall */
    kind: text("kind").notNull().default("post"),
    idempotencyKey: uuid("idempotency_key").notNull().defaultRandom().unique(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a worker takes the job; undo is only possible while this is null */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    platformPostId: text("platform_post_id"),
    permalink: text("permalink"),
    reason: text("reason"),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("publish_jobs_pick_idx").on(t.status, t.nextAttemptAt)],
);

export const publishedPosts = pgTable(
  "published_posts",
  {
    id: id(),
    orgId: orgId(),
    draftId: uuid("draft_id").notNull().references(() => postDrafts.id),
    platform: text("platform").notNull(),
    platformPostId: text("platform_post_id").notNull(),
    permalink: text("permalink").notNull(),
    text: text("text").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid("published_by").references(() => users.id),
    recalledAt: timestamp("recalled_at", { withTimezone: true }),
    recalledBy: uuid("recalled_by").references(() => users.id),
    recallReason: text("recall_reason"),
    /** The card image that went out with the post; null for rows from before it was recorded */
    cardKey: text("card_key"),
    /** Posted by hand on X and recorded by the operator, not sent by the worker */
    manual: boolean("manual").notNull().default(false),
  },
  (t) => [
    uniqueIndex("published_posts_platform_id_key").on(t.platform, t.platformPostId),
    index("published_posts_day_idx").on(t.orgId, t.platform, t.publishedAt),
  ],
);

export const postMetrics = pgTable(
  "post_metrics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    postId: uuid("post_id").notNull().references(() => publishedPosts.id),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    impressions: integer("impressions"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    saves: integer("saves"),
    videoViews: integer("video_views"),
  },
  (t) => [index("post_metrics_post_idx").on(t.postId, t.fetchedAt)],
);

// ─── Web trends (the Web Scraper) ────────────────────────────────────────────

/** How one free source did in a run, for the desk's source health line (core's SourceHealth) */
export interface TrendSourceHealth {
  name: string;
  /** News, Publisher RSS, Government, Trends, Volume, Social, YouTube; absent on the first runs */
  group?: string;
  ok: boolean;
  at: string;
  items: number;
  itemsLastRun: number;
  /** Absent on runs stored before it was recorded */
  lastSuccessAt?: string | null;
  lastError?: string;
}

/** A Rajasthan disaster warning (NDMA Sachet, CAP), as stored with a run */
export interface TrendRunAlert {
  level: "red" | "orange" | "yellow" | "info";
  text: string;
  event: string;
  severity: string;
  validFrom: string | null;
  validUntil: string | null;
  districts: string[];
  issuer: string;
  url: string;
  source: "NDMA Sachet";
}

export const TREND_RUN_TRIGGERS = ["schedule", "startup", "manual", "search"] as const;

/** One pull of the sources. The desk reads the newest finished schedule/startup/manual run. */
export const trendRuns = pgTable(
  "trend_runs",
  {
    id: id(),
    orgId: orgId(),
    trigger: text("trigger").$type<(typeof TREND_RUN_TRIGGERS)[number]>().notNull(),
    /** The search text, for trigger "search" */
    query: text("query"),
    sources: jsonb("sources").$type<TrendSourceHealth[]>().notNull().default(sql`'[]'::jsonb`),
    /** Rajasthan's NDMA Sachet warnings in force at the run */
    alerts: jsonb("alerts").$type<TrendRunAlert[]>().notNull().default(sql`'[]'::jsonb`),
    itemCount: integer("item_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("trend_runs_org_idx").on(t.orgId, t.trigger, t.finishedAt)],
);

/** A ranked topic, article or hashtag of one run, for one window. Pruned with its run after 7 days. */
export const trendItems = pgTable(
  "trend_items",
  {
    id: id(),
    orgId: orgId(),
    runId: uuid("run_id").notNull().references(() => trendRuns.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    window: text("window").notNull(),
    rank: integer("rank").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    platform: text("platform").notNull(),
    sourceName: text("source_name").notNull(),
    reasonWhy: text("reason_why").notNull().default(""),
    superTag: text("super_tag").notNull(),
    subTag: text("sub_tag").notNull().default(""),
    district: text("district"),
    volume: text("volume").notNull().default(""),
    growth: text("growth").notNull().default(""),
    shares: text("shares").notNull().default(""),
    /** A real news headline and its summary: what a draft is made from */
    headline: text("headline").notNull(),
    summary: text("summary").notNull().default(""),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** The publisher's picture (feed or og:image): preview only, never attached to a post */
    imageUrl: text("image_url"),
    imageSource: text("image_source"),
    /** The article page was read once for og:image; never again for this URL */
    ogChecked: boolean("og_checked").notNull().default(false),
    /** The desk's badge: a warning in force for this item's district */
    alert: jsonb("alert").$type<{ level: "red" | "orange" | "yellow" | "info"; title: string; validUntil?: string }>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trend_items_run_idx").on(t.runId, t.type, t.window, t.rank), index("trend_items_url_idx").on(t.url)],
);

// ─── Dictionaries ────────────────────────────────────────────────────────────

export const hashtagRules = pgTable(
  "hashtag_rules",
  {
    id: id(),
    orgId: orgId(),
    matchType: text("match_type").notNull(),
    name: text("name").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    hashtagLatin: text("hashtag_latin").notNull(),
    hashtagDevanagari: text("hashtag_devanagari"),
    priority: integer("priority").notNull().default(0),
    active: boolean("active").notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [index("hashtag_rules_org_idx").on(t.orgId, t.active)],
);

export const handleDirectory = pgTable(
  "handle_directory",
  {
    id: id(),
    orgId: orgId(),
    entityName: text("entity_name").notNull(),
    entityNameHi: text("entity_name_hi"),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    platform: text("platform").notNull().default("x"),
    handle: text("handle").notNull(),
    priority: integer("priority").notNull().default(0),
    source: text("source").notNull().default("manual"),
    /** Required before a handle can ever be suggested */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("handle_directory_verified_idx").on(t.orgId, t.platform).where(sql`${t.verifiedAt} IS NOT NULL`)],
);

/** Wikidata lands here; an editor promotes a row into handle_directory. */
export const handleDirectoryStaging = pgTable(
  "handle_directory_staging",
  {
    id: id(),
    orgId: orgId(),
    entityName: text("entity_name").notNull(),
    entityNameHi: text("entity_name_hi"),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    platform: text("platform").notNull().default("x"),
    handle: text("handle").notNull(),
    description: text("description"),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("handle_staging_source_key").on(t.orgId, t.source, t.sourceId, t.platform)],
);

export const platformCredentials = pgTable(
  "platform_credentials",
  {
    id: id(),
    orgId: orgId(),
    platform: text("platform").notNull(),
    account: text("account").notNull(),
    /** AES-256-GCM; rotating tokens cannot live in env vars */
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("platform_credentials_key").on(t.orgId, t.platform, t.account)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId, t.at)],
);

/** Small state: the FTP watermark, the last Wikidata sync. */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});
