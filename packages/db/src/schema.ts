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

export const stories = pgTable(
  "stories",
  {
    id: id(),
    orgId: orgId(),
    fileId: uuid("file_id").notNull().references(() => ingestedFiles.id),
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
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: id(),
    orgId: orgId(),
    fileId: uuid("file_id").notNull().references(() => ingestedFiles.id),
    storyId: uuid("story_id").references(() => stories.id),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    seq: integer("seq"),
    storageKey: text("storage_key").notNull(),
    /** "auto" by slug, or "manual" from the attach picker */
    attachedBy: text("attached_by"),
    createdAt: createdAt(),
  },
  (t) => [index("assets_slug_idx").on(t.orgId, t.slug, t.createdAt), index("assets_story_idx").on(t.storyId)],
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
    cardFontPx: integer("card_font_px"),
    renderError: text("render_error"),
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
