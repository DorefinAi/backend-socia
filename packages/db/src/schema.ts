// Tables: spec v1.1 §6.8 plus the Phase 1 additions in the backend architecture doc §10.
// org_id is on every table from day one: Socia is meant to run for more than one media house.

import type { DistrictFrom, FileTags, HandlePick, StoryClass } from "@socia/core";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, bigint, bigserial, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid,
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

/**
 * One user's own settings that follow them to any computer (migration 0020). Every key is optional; readers
 * ignore keys they do not know. keyBindings: desk action id -> 0-2 key combos ([] = action turned off); an action
 * missing here uses the desk's default keys.
 */
export interface UserPrefs {
  keyBindings?: Record<string, string[]>;
}

/** The built-in roles (migration 0009 made roles a table; custom roles are any other key there) */
export const USER_ROLES = ["operator", "editor", "admin", "viewer"] as const;
/** A key in roles: one of USER_ROLES or a custom role's slug */
export type UserRole = string;

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
    /** Time step (unix seconds / 30) of the last accepted TOTP code; a code at this step or earlier is refused (no replay) */
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    /** roles.key in the same org */
    role: text("role").$type<UserRole>().notNull(),
    /** Users of a platform-scoped role (operator) act only on these platforms */
    platforms: text("platforms").array().notNull().default(sql`'{x}'::text[]`),
    /** Inactive users cannot sign in; deactivating deletes their sessions */
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    /** Last password sign-in; null before migration 0009 or for someone who never signed in */
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** The user's own preferences (UserPrefs); {} when none are set */
    prefs: jsonb("prefs").$type<UserPrefs>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    index("users_org_role_idx").on(t.orgId, t.role),
    foreignKey({ name: "users_org_role_fk", columns: [t.orgId, t.role], foreignColumns: [roles.orgId, roles.key] }),
  ],
);

// ─── Access control (contract: handoff/access-control-contract.md §3) ───────

/** Per org: the 4 built-ins (seeded by a trigger on orgs) and custom roles. */
export const roles = pgTable(
  "roles",
  {
    orgId: orgId(),
    /** "admin", "editor", "operator", "viewer", or a custom role's slug ("video-editor") */
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    builtIn: boolean("built_in").notNull().default(false),
    /** Users of the role act only on their own platforms (like operator) */
    platformScoped: boolean("platform_scoped").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "roles_pkey", columns: [t.orgId, t.key] }),
    check("roles_key_check", sql`${t.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.key}) <= 40`),
    check("roles_label_check", sql`length(${t.label}) BETWEEN 1 AND 40`),
  ],
);

/** A role's setting for one permission. No row: the built-in default (built-ins) or not allowed (custom). */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    orgId: uuid("org_id").notNull(),
    roleKey: text("role_key").notNull(),
    permission: text("permission").notNull(),
    allowed: boolean("allowed").notNull(),
  },
  (t) => [
    primaryKey({ name: "role_permissions_pkey", columns: [t.orgId, t.roleKey, t.permission] }),
    foreignKey({ name: "role_permissions_role_fk", columns: [t.orgId, t.roleKey], foreignColumns: [roles.orgId, roles.key] }).onDelete("cascade"),
  ],
);

/** One user's exception to their role: allow or deny one permission. */
export const userPermissionOverrides = pgTable(
  "user_permission_overrides",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    allowed: boolean("allowed").notNull(),
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "user_permission_overrides_pkey", columns: [t.userId, t.permission] })],
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

/** An org template's layout: as CardLayout, but a design may have no date (date null: none is drawn). */
export type OrgCardLayout = Omit<CardLayout, "date"> & { date: CardLayout["date"] | null };

/** The story tags an org template can open by default on */
export const ORG_TEMPLATE_DEFAULT_FOR = ["big_breaking", "breaking"] as const;
export type OrgTemplateDefaultFor = (typeof ORG_TEMPLATE_DEFAULT_FOR)[number];

/**
 * The org's shared card designs (contract: dev-docs/org-card-templates-contract.md). Seeded by the CLI
 * (seed-card-templates); anyone signed in reads them, Settings may move the drawing areas.
 */
export const orgCardTemplates = pgTable(
  "org_card_templates",
  {
    id: id(),
    orgId: orgId(),
    platform: text("platform").notNull().default("x"),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    backgroundKey: text("background_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    layout: jsonb("layout").$type<OrgCardLayout>().notNull(),
    defaultFor: text("default_for").array().$type<OrgTemplateDefaultFor[]>().notNull().default(sql`'{}'::text[]`),
    sort: integer("sort").notNull().default(0),
    /** Who uploaded it (v2); null for seeded templates and when that user is deleted */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("org_card_templates_org_platform_slug_key").on(t.orgId, t.platform, t.slug),
    check("org_card_templates_slug_check", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.slug}) <= 40`),
    check("org_card_templates_default_for_check", sql`${t.defaultFor} <@ ARRAY['big_breaking', 'breaking']::text[]`),
  ],
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
  (t) => [
    uniqueIndex("ingested_files_sha256_key").on(t.orgId, t.sha256),
    index("ingested_files_slug_idx").on(t.orgId, t.slug),
    // Breaking share: is this path done, and which story is it (re-saves)
    index("ingested_files_path_idx").on(t.orgId, t.sourcePath, t.ingestedAt),
  ],
);

export const STORY_STATUSES = ["ingested", "converted", "composed", "failed", "archived"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];
export const MEDIA_STATES = ["awaiting", "attached", "none"] as const;

/** Where a story's text came from: a file on the share/folder, or an approved story in Samvadia. */
/** file: the shared folder / FTP; samvadia: its database; trend: a Web Scraper item turned into a story */
export const STORY_SOURCES = ["file", "samvadia", "trend"] as const;
export type StorySource = (typeof STORY_SOURCES)[number];

export const STORY_LAYOUTS = ["breaking"] as const;
export type StoryLayout = (typeof STORY_LAYOUTS)[number];

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
    /**
     * Where a breaking file's district came from (core DistrictFrom): place_line, headline_prefix and tag are
     * the desk's own words and may reach the post; file_code is stated unless the reporter files for no single
     * district (core storyDistrict); text was inferred and is only offered (b6 fix brief P0). Null for other
     * stories and for rows stored before migration 0023 (the compose stage recovers it from the stored file).
     */
    districtFrom: text("district_from").$type<DistrictFrom>(),
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
    /** How the text file is laid out: "breaking" (the newsroom's breaking files, phase 1); null = line 1 is the headline */
    layout: text("layout").$type<StoryLayout>(),
    /** Hindi town from a breaking file's place line ("रावतभाटा"); null when none */
    town: text("town"),
    /** Tags from a breaking file's name (district code, BIG/FULL/UPDATE, desk, reporter); null for other stories */
    fileTags: jsonb("file_tags").$type<FileTags>(),
    /** Why a breaking story wants a human look (core NEEDS_CHECK codes); empty when fine */
    needsCheck: text("needs_check").array().notNull().default(sql`'{}'::text[]`),
    /** The desk instruction taken out of the text ("नोट-: ... फुलस्क्रीन करावें"); null when none */
    deskNote: text("desk_note"),
    /** A breaking file saved again after its post went out: the posted draft this story updates (migration 0016) */
    updateOfDraftId: uuid("update_of_draft_id").references((): AnyPgColumn => postDrafts.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("stories_status_idx").on(t.status, t.createdAt),
    index("stories_slug_idx").on(t.orgId, t.slug, t.createdAt),
    uniqueIndex("stories_external_key").on(t.orgId, t.source, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
    index("stories_source_recent_idx").on(t.source, t.createdAt),
    // Stories of an org in a period (status counts, pairing)
    index("stories_org_created_idx").on(t.orgId, t.createdAt),
    // The story search sweep: stories edited in the last minutes (migration 0025)
    index("stories_updated_idx").on(t.updatedAt.desc()),
  ],
);

/**
 * The story search index (migration 0025, GET /search/stories): one row per story, kept current by the worker's
 * search sweep (rows missing, or stories.updated_at newer than source_updated_at). Text columns hold core
 * fold() / phoneticKey() output wrapped in single spaces (" जयपुर हादसा "), so a query form matches a word's start
 * with LIKE '% form%' and a whole word with LIKE '% form %'. The headline columns only rank (a headline hit first).
 */
export const storySearch = pgTable(
  "story_search",
  {
    storyId: uuid("story_id").primaryKey().references(() => stories.id, { onDelete: "cascade" }),
    orgId: orgId(),
    /** fold(headline, body, town, district) */
    searchText: text("search_text").notNull(),
    /** phoneticKey of the same */
    searchKey: text("search_key").notNull(),
    /** fold(headline) and its phoneticKey */
    headlineText: text("headline_text").notNull().default(""),
    headlineKey: text("headline_key").notNull().default(""),
    /** stories.updated_at when this row was built */
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    /** stories.created_at (never changes): ranks and caps candidates without joining stories */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("story_search_text_trgm").using("gin", t.searchText.op("gin_trgm_ops")),
    index("story_search_key_trgm").using("gin", t.searchKey.op("gin_trgm_ops")),
    index("story_search_org_created_idx").on(t.orgId, t.createdAt.desc()),
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
    /**
     * Topic hashtags the org's rules matched, offered to the desk and never applied on their own
     * (migration 0022). Breaking drafts only; empty on everything else.
     */
    hashtagSuggestions: text("hashtag_suggestions").array().notNull().default(sql`'{}'::text[]`),
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
    /** How a Web Scraper draft was reworded from the publishers' text; null for every other draft */
    rewrite: jsonb("rewrite").$type<DraftRewrite>(),
    /** Breaking drafts: the story class, the reason and the warnings behind the handles (migration 0021) */
    handlePick: jsonb("handle_pick").$type<DraftHandlePick>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("post_drafts_story_platform_key").on(t.storyId, t.platform),
    index("post_drafts_queue_idx").on(t.orgId, t.platform, t.status, t.createdAt),
    // The rejected and posted views page by last change, newest first, keyset (updated_at, id)
    index("post_drafts_queue_updated_idx").on(t.orgId, t.platform, t.status, t.updatedAt.desc(), t.id.desc()),
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
    /** Null for a "Copy & Posted" post: pasted on X by hand, no link recorded (migration 0015) */
    platformPostId: text("platform_post_id"),
    permalink: text("permalink"),
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
    // Who posted a draft and when (posted view, Copy & Posted undo)
    index("published_posts_draft_idx").on(t.draftId, t.publishedAt),
    // At most one live Copy & Posted record per draft, whatever two clicks race
    uniqueIndex("published_posts_copied_draft_key").on(t.draftId).where(sql`${t.permalink} IS NULL AND ${t.recalledAt} IS NULL`),
  ],
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
    /** Items about the same story share it; null on runs stored before migration 0007 (each its own story) */
    clusterId: text("cluster_id"),
    /** The story's place among its type and window's stories; null before 0007 (= rank) */
    clusterRank: integer("cluster_rank"),
    /** One per publisher or channel that has the story, newest first */
    sources: jsonb("sources").$type<TrendItemSource[]>().notNull().default(sql`'[]'::jsonb`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trend_items_run_idx").on(t.runId, t.type, t.window, t.rank), index("trend_items_url_idx").on(t.url)],
);

/** post_drafts.rewrite (handoff/web-scraper-contract.md, "Draft rewording") */
/**
 * Why a breaking draft got the handles it got (migration 0021). The class is the decision every handle
 * rule hangs off, so an editor who disagrees with the class is telling us something that moves hundreds
 * of posts, not one. `warnings` never blocked a tag: an unknown reporter token, an unknown district
 * code, a reporter filing outside their usual district.
 */
export interface DraftHandlePick {
  /** incident, administration, political, government, judicial, soft, leader_post, other */
  cls: StoryClass;
  why: string;
  warnings: string[];
  /** The handles the rules chose, with the reason each was chosen for */
  handles: { handle: string; reason: HandlePick["reason"]; title?: string }[];
  /** The reporter token read from the file name, matched or not — the roster's to-do list */
  reporterToken?: string | null;
  /** Offered, not in the post: each with its reason (core HandlePick) */
  suggested?: { handle: string; reason: HandlePick["reason"]; title?: string }[];
  /** hashtag_suggestions with the rule id and reason line behind each (reporter-prior brief §2.3); absent before */
  tagSuggestions?: { tag: string; source: string; reason: string; score?: number; n?: number }[];
}

export interface DraftRewrite {
  /** REWRITE_MODE that made it; only "rules" exists */
  mode: "rules";
  /** Word 4-gram overlap with the closest source (0..1, see @socia/core copyStats) */
  similarity: number;
  /** similarity > 0.4 even after the retries: reword by hand before posting */
  tooClose: boolean;
  /** The publishers whose text went into the draft, the lead item's first */
  sources: { name: string; url: string }[];
}

export interface TrendItemSource {
  name: string;
  url: string;
  publishedAt: string | null;
}

/** Keywords a desk user watches in the Web Scraper (at most 50 each) */
export const trendWatches = pgTable(
  "trend_watches",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("trend_watches_user_keyword_key").on(t.userId, sql`lower(${t.keyword})`),
    index("trend_watches_org_idx").on(t.orgId),
  ],
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
    /** The rule does not fire from a sentence that also has one of these (हादसा + "टल गया": an averted accident) */
    negativePhrases: text("negative_phrases").array().notNull().default(sql`'{}'::text[]`),
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

/**
 * handle_directory.source for the reporter rows the desk teaches us: when an editor adds a reporter's
 * handle to a breaking draft by hand, that story's file-name token is recorded in `aliases` here, and the
 * worker merges those tokens into the reporter list on its next reload. "desk" rows are a different thing
 * (handles with keywords, matched against the copy) and the two must not be mixed.
 */
export const REPORTER_SOURCE = "reporter";

/**
 * Hashtags the desk typed on a draft that no rule of ours produced (migration 0022).
 *
 * The composer applies only the footer tag and offers the topic rules; anything else on a post came from
 * an editor's own hands, and that is the most direct evidence there is of a tag the rules are missing.
 * Each one is counted here with a few example headlines, for the weekly pass where somebody decides
 * whether it deserves a rule and what keywords should fire it. Nothing in this table is ever tagged
 * automatically — a row is a question for a human, not a rule.
 */
export const hashtagStaging = pgTable(
  "hashtag_staging",
  {
    id: id(),
    orgId: orgId(),
    /** As the editor wrote it, with the # ("#RajasthanPanchayatElection2026") */
    tag: text("tag").notNull(),
    /** Lower-cased without the #, so one tag is one row whatever the casing */
    tagKey: text("tag_key").notNull(),
    /** How many times an editor has added it */
    uses: integer("uses").notNull().default(1),
    /** A few recent headlines it was added to, for the weekly review: {draftId, headline, at}[] */
    examples: jsonb("examples").notNull().default(sql`'[]'::jsonb`),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when somebody turned it into a hashtag_rules row; dismissed when it was judged a one-off */
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("hashtag_staging_key").on(t.orgId, t.tagKey), index("hashtag_staging_review_idx").on(t.orgId, t.uses.desc())],
);

/** One example headline a staged hashtag was added to */
export interface HashtagStagingExample {
  draftId: string;
  headline: string;
  at: string;
}

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
    /** Who acted when it was not a user: "owner:<name>" for the owner console (actorId is then null) */
    actor: text("actor"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId, t.at),
    // The change history of roles and users (GET /admin/audit), newest first
    index("audit_log_org_type_idx").on(t.orgId, t.entityType, t.at, t.id),
    // The owner console's history (GET /owner/history): user changes across orgs, newest first, keyset (at, id)
    index("audit_log_type_at_idx").on(t.entityType, t.at.desc(), t.id.desc()),
  ],
);

/** Small state: the FTP watermark, the last Wikidata sync. */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

/**
 * Every log line of the API and worker at OPS_LOG_LEVEL and above, already redacted (dev-docs/ops-logs-contract.md
 * §1, written by ops-log.ts). The Sentry control centre pulls them through GET /owner/logs; kept 14 days.
 */
export const opsLog = pgTable(
  "ops_log",
  {
    /** The pull cursor: strictly increasing */
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** When the line was logged (the logger's time) */
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Sentry system id: socia-api, socia-ingest, socia-render, socia-publish, socia-crons */
    system: text("system").notNull(),
    level: text("level").notNull(),
    logger: text("logger"),
    message: text("message").notNull(),
    slug: text("slug"),
    itemId: text("item_id"),
    fields: jsonb("fields"),
  },
  // For the hourly retention delete
  (t) => [index("ops_log_at_idx").on(t.at)],
);

/** One row per running API / worker process, beaten every 30 s (contract §1) */
export const opsHeartbeat = pgTable("ops_heartbeat", {
  process: text("process").primaryKey(),
  system: text("system").notNull(),
  host: text("host").notNull(),
  pid: integer("pid").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  beatAt: timestamp("beat_at", { withTimezone: true }).notNull(),
  info: jsonb("info"),
});

// ─── Decision log (reporter-prior brief §2, §7; migration 0024) ──────────────

/** One item's fate once the desk decided (brief §2.4) */
export const ITEM_OUTCOMES = ["kept", "removed", "accepted", "ignored", "desk_added"] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];

/** How the desk decided a draft: Copy & Posted, a recorded manual post with its link, an API post, or Reject */
export const DECISIONS = ["copy_posted", "mark_posted", "approved", "rejected"] as const;
export type Decision = (typeof DECISIONS)[number];

/** One proposed item as the log stores it: core's Proposal (source and reason), plus explore */
export interface LoggedProposal {
  item: string;
  kind: "hashtag" | "handle";
  layer: "emit" | "suggest";
  source: string;
  reason: string;
  score?: number;
  n?: number;
  explore?: boolean;
}

/** One item in item_outcomes: a proposal's fate, or an item the desk added that no rule proposed */
export interface LoggedItemOutcome {
  item: string;
  kind: "hashtag" | "handle";
  /** null for desk_added */
  layer: "emit" | "suggest" | null;
  /** The rule id; "desk" for desk_added */
  source: string;
  outcome: ItemOutcome;
}

/** An outcome taken back (Copy & Posted undone, a rejected draft restored), kept rather than overwritten */
export interface VoidedOutcome {
  /** Every outcome column as it stood, built by the database itself (the trigger checks it matches) */
  outcome: {
    decision: Decision;
    decided_at: string;
    decided_by: string | null;
    reject_reason: string | null;
    final_text: string | null;
    final_hashtags: string[] | null;
    final_handles: string[] | null;
    item_outcomes: LoggedItemOutcome[] | null;
    rework_ratio: number | null;
  };
  /** The proposal the outcome was measured against */
  proposal: { proposals: LoggedProposal[]; draft_text: string; proposal_rev: number; proposal_stale: boolean };
  voided_at: string;
  voided_by: string | null;
  /**
   * True when the void was not written at the undo or restore itself (that write failed) and the next decision
   * found the withdrawn one still in place; it is voided then, before the new one is written
   */
  late: boolean;
}

/**
 * The decision log: what the composer proposed for a breaking draft and, once, what the desk did with it.
 *
 * Two halves. The proposal half is written by the worker when it composes the draft (and refreshed only while
 * nobody has decided). The outcome half is written once when the desk decides: Copy & Posted, Mark posted or
 * Reject. Nothing ever rewrites a decided row's proposal or outcome; an undo or a restore moves the outcome
 * into `voided` and the next decision is written fresh. A trigger in migration 0024 enforces this.
 *
 * Writing here never blocks or fails a draft or a desk action: every write is in a savepoint, caught and logged.
 */
export const postDecisions = pgTable(
  "post_decisions",
  {
    id: id(),
    orgId: orgId(),
    draftId: uuid("draft_id").notNull().references(() => postDrafts.id),
    storyId: uuid("story_id").notNull().references(() => stories.id),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Bumped when a re-saved file rewrites an undecided draft */
    proposalRev: integer("proposal_rev").notNull().default(1),
    // What the file name said about the reporter (brief §2.2, core resolveReporterStatus): file name only (L1)
    filenameRaw: text("filename_raw"),
    slotRaw: text("slot_raw"),
    reporterToken: text("reporter_token"),
    bureauCode: text("bureau_code"),
    bureauDistrict: text("bureau_district"),
    reporterHandle: text("reporter_handle"),
    /** matched, unknown_token, collision, bureau_code, unknown_bureau_code, no_slot, no_filename */
    reporterStatus: text("reporter_status").notNull(),
    storyClass: text("story_class"),
    district: text("district"),
    districtFrom: text("district_from"),
    /** The tagging logic that proposed ("tags-v3+prior-1") and the data files behind it (compose_version) */
    logicVersion: text("logic_version").notNull(),
    composeVersion: text("compose_version").notNull(),
    /** The post as composed (postText): the rework ratio's baseline */
    draftText: text("draft_text").notNull(),
    proposals: jsonb("proposals").$type<LoggedProposal[]>().notNull(),
    /**
     * A re-saved file rewrote the draft after the desk decided (a rejected draft is rewritten in place), so the
     * proposal no longer describes the draft. Set once, never cleared on a decided row; a later outcome then
     * records the final post but no item outcomes or rework ratio, which would measure the re-save, not the desk.
     */
    proposalStale: boolean("proposal_stale").notNull().default(false),
    /** One post in ten is an exploration post (brief §7.2.3); its proposals carry explore: true */
    explore: boolean("explore").notNull().default(false),
    // The outcome half: null until the desk decides
    decision: text("decision").$type<Decision>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id),
    rejectReason: text("reject_reason"),
    finalText: text("final_text"),
    finalHashtags: text("final_hashtags").array(),
    finalHandles: text("final_handles").array(),
    itemOutcomes: jsonb("item_outcomes").$type<LoggedItemOutcome[]>(),
    /** Edit distance (tags, handles and links stripped) over the stripped draft's length (brief §2.5) */
    reworkRatio: real("rework_ratio"),
    voided: jsonb("voided").$type<VoidedOutcome[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    uniqueIndex("post_decisions_draft_key").on(t.draftId),
    // The nightly features read a window of decided rows of matched reporters
    index("post_decisions_features_idx").on(t.orgId, t.decidedAt).where(sql`${t.decidedAt} IS NOT NULL AND ${t.reporterStatus} = 'matched'`),
    // One reporter's rows (reporter_features is keyed by handle)
    index("post_decisions_reporter_handle_idx").on(t.orgId, t.reporterHandle),
    // The weekly reporter-status report reads a week of proposals
    index("post_decisions_proposed_idx").on(t.orgId, t.proposedAt),
    check("post_decisions_outcome_whole", sql`(${t.decidedAt} IS NULL) = (${t.decision} IS NULL) AND (${t.finalText} IS NULL) = (${t.decision} IS NULL)`),
    check("post_decisions_decision_known", sql`${t.decision} IS NULL OR ${t.decision} IN ('copy_posted', 'mark_posted', 'approved', 'rejected')`),
    check("post_decisions_proposals_array", sql`jsonb_typeof(${t.proposals}) = 'array' AND jsonb_typeof(${t.voided}) = 'array'`),
    check("post_decisions_rework_range", sql`${t.reworkRatio} IS NULL OR ${t.reworkRatio} >= 0`),
  ],
);

/**
 * Per-reporter features, one snapshot per IST day (brief §7.1), keyed by the reporter's HANDLE (one reporter files
 * under several file-name tokens). Built from the posted decisions of matched reporters in the 90 days before the
 * start of that day (L5), at most 200 items per reporter. A snapshot is never overwritten: a second run on the
 * same day inserts nothing, and UPDATE is refused; snapshots older than 90 days are deleted. NOTHING reads these
 * yet.
 */
export const reporterFeatures = pgTable(
  "reporter_features",
  {
    orgId: orgId(),
    /** The IST day the snapshot was taken for; it uses decisions before that day's start */
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    /** The reporter's handle, lower-cased, no @ (post_decisions.reporter_handle of matched rows) */
    reporter: text("reporter").notNull(),
    /** The posts the features rest on */
    n: integer("n").notNull(),
    features: jsonb("features").$type<ReporterFeatureSet>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.snapshotDate, t.reporter] })],
);

/** One item's rate for one reporter: raw count over n, and smoothed toward the desk's overall rate with m */
export interface ReporterItemFeature {
  count: number;
  rate: number;
  /** (count + m · base) / (n + m) */
  smoothed: number;
  /** The desk's overall rate for the item across every reporter in the window */
  base: number;
}

export interface ReporterFeatureSet {
  m: number;
  /** Decisions before this instant only (L5) */
  cutoff: string;
  /** ...and from this instant on (the rolling window, FEATURE_WINDOW_DAYS before the cutoff) */
  since: string;
  /** The reporter's items beyond the top FEATURE_MAX_ITEMS by count, left out */
  itemsDropped: number;
  /** "#jaipur", "@rajgovofficial" (lower-cased): on the final post */
  items: Record<string, ReporterItemFeature & { kind: "hashtag" | "handle" }>;
  /** Per rule id: how often the desk kept or accepted what the rule proposed for this reporter */
  sources: Record<string, { proposed: number; taken: number; rate: number; smoothed: number; base: number }>;
  /** Mean rework ratio of this reporter's posts */
  reworkMean: number | null;
}
