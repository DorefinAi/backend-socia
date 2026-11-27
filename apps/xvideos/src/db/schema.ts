// X Videos tables, in their own Postgres schema "xvideos" with their own migrations (apps/xvideos/migrations, journal
// xvideos.__migrations). Nothing here alters a table of the X post desk (schema public); the only link is org_id.
// Steps 1–4 of apps/xvideos/README.md: the clips found on the share, their work queue, what the media service read
// from them, and the screen read with the model's headline. Drafts, holds and posts come with steps 5-6.

import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, date, index, integer, jsonb, pgSchema, primaryKey, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orgs } from "@socia/db";

export const xvideos = pgSchema("xvideos");

/** seen: on the share, not settled yet · reading: being probed / read · new: ready on the desk · failed · gone: left the share */
export const XV_CLIP_STATUSES = ["seen", "reading", "new", "failed", "gone"] as const;
export type XvClipStatus = (typeof XV_CLIP_STATUSES)[number];

/**
 * The steps of a clip, in order: probe always; read (speech, cuts, stills) only with XVIDEOS_SPEECH=on; headline (the
 * screen read and the model's headline, README §4.2) only when the file's name holds no heading
 */
export const XV_STEPS = ["probe", "read", "headline"] as const;
export type XvStep = (typeof XV_STEPS)[number];

export const XV_JOB_STATUSES = ["pending", "running", "done", "failed"] as const;
export type XvJobStatus = (typeof XV_JOB_STATUSES)[number];

export const xvClips = xvideos.table(
  "clip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => orgs.id),
    /** Folder parts under the share root, as found: ["2026", "NOVEMBER 2026", "24-11-2026", "Convert 3 pm to"] */
    folder: text("folder").array().notNull(),
    /** The file's name on the share, marks included; updated when the desk renames it */
    fileName: text("file_name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mtime: timestamp("mtime", { withTimezone: true }).notNull(),
    /** size:mtime (rules xvFingerprint): with `day`, the identity that survives a rename */
    fingerprint: text("fingerprint").notNull(),
    picked: boolean("picked").notNull(),
    done: boolean("done").notNull(),
    /** The name without marks and extension (often the desk's title) */
    title: text("title").notNull(),
    /** The day folder's date ("2026-11-27"): the desk lists one day folder at a time */
    day: date("day", { mode: "string" }),
    /** The posted title when the file's name is one (rules xvHeading), else null: the screen read finds it */
    heading: text("heading"),
    status: text("status").$type<XvClipStatus>().notNull().default("seen"),
    /** 0–100 while reading */
    progress: integer("progress"),
    /** When two scans in a row saw the same size: the copy onto the share has finished */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    durationS: real("duration_s"),
    width: integer("width"),
    height: integer("height"),
    videoCodec: text("video_codec"),
    hasAudio: boolean("has_audio"),
    /** The poster still, relative to XVIDEOS_CACHE */
    posterKey: text("poster_key"),
    error: text("error"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    goneAt: timestamp("gone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One clip per video per day folder: a copy in another day's folder is that day's own clip
    uniqueIndex("clip_org_day_fingerprint").on(t.orgId, t.day, t.fingerprint),
    index("clip_org_status_seen").on(t.orgId, t.status, t.firstSeenAt),
    // The desk's list: newest file first
    index("clip_org_mtime").on(t.orgId, t.mtime.desc()),
    // One day folder's clips, and the day selector's counts
    index("clip_org_day").on(t.orgId, t.day, t.mtime.desc()),
  ],
);

export const xvJobs = xvideos.table(
  "clip_job",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    clipId: uuid("clip_id").notNull().references(() => xvClips.id, { onDelete: "cascade" }),
    step: text("step").$type<XvStep>().notNull(),
    status: text("status").$type<XvJobStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("clip_job_clip_step").on(t.clipId, t.step),
    // The two claim paths (clips.ts xvClaimJob): pending and due, then running with the lease run out
    index("clip_job_due").on(t.step, t.nextAttemptAt).where(sql`status = 'pending'`),
    index("clip_job_lease").on(t.step, t.leaseUntil).where(sql`status = 'running'`),
  ],
);

/** Speech, cuts, frames and screen text of one clip: the media service's whole answer, kept so later steps never re-run the GPU */
export interface XvEvidence {
  mediaVersion: string;
  language: string;
  /** Seconds the read took on the media service */
  tookS: number;
  transcript: { at: number; end: number; text: string }[];
  cutTimes: number[];
  /** Stills, relative to XVIDEOS_CACHE */
  frames: { at: number; key: string }[];
  contactSheetKey: string | null;
}

export const xvEvidence = xvideos.table("clip_evidence", {
  clipId: uuid("clip_id").primaryKey().references(() => xvClips.id, { onDelete: "cascade" }),
  mediaVersion: text("media_version").notNull(),
  evidence: jsonb("evidence").$type<XvEvidence>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** What the media service read off one clip's screen (POST /screen), and the anchor's opening words when asked (POST /speech) */
export interface XvScreenRead {
  tookS: number;
  durationS: number;
  /** The headline bar's lines in the order they showed, as read (the day's programme filler is dropped later) */
  barLines: { text: string; secs: number; firstS: number }[];
  /** Place tag, right panel, name strips */
  otherText: string[];
  timings: { framesS: number; ocrS: number };
  /** The anchor's opening words, read when the bar showed too few lines; null: not read */
  speech: { text: string; seconds: number; tookS: number; hasAudio?: boolean } | null;
}

/** How the model's headline was made: what it was given and what else it said (place and topics go to step 5) */
export interface XvHeadlineResult {
  model: string;
  tookS: number;
  tokensOut: number | null;
  placeHindi: string;
  district: string;
  state: string;
  topicHashtags: string[];
  /** The bar lines the model was given: programme filler dropped, the programme's name cut off (lines.ts) */
  linesUsed: string[];
  /** Bar lines left out as the day's programme filler */
  dropped: string[];
  usedSpeech: boolean;
  /** Why the model's headline was not offered (it was about the clip, not the news); the desk then shows none */
  rejected?: string;
}

/** Step 4 for a clip whose name holds no heading: the screen read and the model's headline */
export const xvScreens = xvideos.table("clip_screen", {
  clipId: uuid("clip_id").primaryKey().references(() => xvClips.id, { onDelete: "cascade" }),
  /** The media service's SCREEN_VERSION when it read the clip */
  screenVersion: text("screen_version").notNull(),
  read: jsonb("read").$type<XvScreenRead>().notNull(),
  /** The model's headline (no suffix), the desk's suggestion; null until the model has answered */
  headline: text("headline"),
  result: jsonb("result").$type<XvHeadlineResult>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The desk's Refresh button: a day folder to walk now (API → watcher). The watcher takes the row, walks the day, and
 * walks it once more a few seconds later so new files settle.
 */
export const xvScanRequests = xvideos.table(
  "scan_request",
  {
    orgId: uuid("org_id").notNull().references(() => orgs.id),
    day: date("day", { mode: "string" }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] })],
);

export type XvClipRow = typeof xvClips.$inferSelect;
export type XvJobRow = typeof xvJobs.$inferSelect;
export type XvScreenRow = typeof xvScreens.$inferSelect;
