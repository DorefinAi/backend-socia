// Ingest from Samvadia (SOURCE_MODE=samvadia). The assignment desk approves a story in Samvadia; when
// it enters Samvadia's feed (stories.state = 'ready') it becomes a Socia story here, already in Unicode,
// so it skips Kruti Dev conversion and goes straight to compose → render → the operator.
//
// Text comes only from Samvadia's database. Media comes only from the story's footage folder on the
// newsroom FTP (items.footage_path), which is READ ONLY for Socia: list and download, nothing else.
// Footage that turns up later (late uploads, or a path Samvadia fills in afterwards) still attaches
// for PAIR_WINDOW_HOURS, by re-listing recent stories' folders every MEDIA_RESCAN_SECONDS.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { slugParts } from "@socia/core";
import {
  PAIR_WINDOW_HOURS, assets, getKv, notify, postDrafts, recordIngestPoll, setKv, stories,
  type Db, type IngestError, type StoryExternal,
} from "@socia/db";
import type { FootageFile, FootageSource, Storage } from "@socia/providers";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { asCategory, asPriority, mapStory, type Cursor, type SamvadiaSource, type SamvadiaStory } from "@socia/db";

export const CURSOR_KEY = "samvadia.cursor";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** Re-read stories stamped this far before the cursor, in case they committed late */
const OVERLAP_MS = 10 * 60 * 1000;
/** A footage file is copied once two looks this far apart see the same size (or it is old enough) */
const STABLE_MS = 2000;
const SETTLED_MS = 10 * 60 * 1000;

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", mxf: "application/mxf", mkv: "video/x-matroska", m4v: "video/mp4",
};

export interface MediaSettings {
  /** Lower-case extensions that are copied or recorded; anything else in the folder is ignored */
  types: string[];
  maxBytes: number;
  /** Copy video files too; when false they are only recorded */
  video: boolean;
}

export interface SamvadiaIngestDeps {
  db: Db;
  storage: Storage;
  reader: SamvadiaSource;
  footage: FootageSource;
  orgId: string;
  log: Logger;
  media: MediaSettings;
  /** How often recent stories' folders are listed again for late footage */
  rescanMs: number;
  /** On the very first run (no cursor yet), how far back to take stories */
  backfillHours: number;
  batch?: number;
  now?: () => number;
}

type Story = typeof stories.$inferSelect;

export class SamvadiaIngest {
  private readonly seen = new Map<string, { sig: string; at: number }>();
  private lastRescan = 0;

  constructor(private readonly deps: SamvadiaIngestDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One poll: new stories, then footage. Returns stories + media files taken. Records ingest status. */
  async poll(): Promise<number> {
    const { db, orgId, log } = this.deps;
    const itemErrors: IngestError[] = [];
    let cursor: Cursor | null = null;
    try {
      const { created, cursor: c } = await this.takeStories(itemErrors);
      cursor = c;
      const media = await this.takeMedia(created, itemErrors);
      await recordIngestPoll(db, orgId, { mode: "samvadia", taken: created.length + media, itemErrors, cursor }, new Date(this.now()));
      return created.length + media;
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      log.error({ err }, "samvadia poll failed; will try again");
      await recordIngestPoll(db, orgId, { mode: "samvadia", taken: 0, error: message, itemErrors, ...(cursor && { cursor }) }, new Date(this.now())).catch(() => undefined);
      throw err;
    }
  }

  // ─── Stories ───────────────────────────────────────────────────────────────

  private async loadCursor(): Promise<Cursor> {
    const saved = await getKv<Cursor>(this.deps.db, CURSOR_KEY);
    if (saved) return saved;
    return { publishedAt: new Date(this.now() - this.deps.backfillHours * 3600_000).toISOString(), storyId: NIL_UUID };
  }

  async takeStories(itemErrors: IngestError[] = []): Promise<{ created: Story[]; cursor: Cursor }> {
    const { db, reader, orgId, log } = this.deps;
    const cursor = await this.loadCursor();
    const { fresh, late } = await reader.storiesSince(cursor, OVERLAP_MS, this.deps.batch ?? 200);
    const candidates = [...late, ...fresh];
    const created: Story[] = [];
    if (candidates.length) {
      const ids = candidates.map((s) => mapStory(s).externalId);
      const known = new Set(
        (await db.select({ id: stories.externalId }).from(stories).where(and(eq(stories.orgId, orgId), eq(stories.source, "samvadia"), inArray(stories.externalId, ids)))).map((r) => r.id),
      );
      for (const s of candidates) {
        const mapped = mapStory(s);
        if (known.has(mapped.externalId)) continue;
        known.add(mapped.externalId);
        try {
          const row = await this.insertStory(s);
          if (row) {
            created.push(row);
            log.info({ storyId: row.id, samvadiaStory: s.id, version: s.version, slug: s.slug, district: row.district }, "samvadia story ingested");
          }
        } catch (err) {
          itemErrors.push({ at: new Date(this.now()).toISOString(), message: `Story ${s.slug}: ${String((err as Error)?.message ?? err).slice(0, 300)}` });
          log.error({ err, samvadiaStory: s.id }, "could not ingest samvadia story");
        }
      }
    }

    // The cursor follows the fresh rows only; a failed row is retried through the overlap window
    const last = fresh[fresh.length - 1];
    const next = last ? { publishedAt: new Date(last.publishedAt).toISOString(), storyId: last.id } : cursor;
    if (last) await setKv(db, CURSOR_KEY, next);
    return { created, cursor: next };
  }

  private async insertStory(s: SamvadiaStory): Promise<Story | null> {
    const { db, orgId } = this.deps;
    const m = mapStory(s);
    const external: StoryExternal = {
      storyId: s.id,
      itemId: s.itemId,
      version: s.version,
      kind: s.kind,
      guid: s.guid,
      title: s.title,
      reporter: s.reporterSlug,
      districtCode: s.districtCode,
      publishedAt: new Date(s.publishedAt).toISOString(),
      footagePath: s.footagePath,
      footageStatus: s.footageStatus,
      priority: asPriority(s.priority),
      category: asCategory(s.category),
    };
    const failed = !m.headline;
    const [row] = await db
      .insert(stories)
      .values({
        orgId,
        source: "samvadia",
        externalId: m.externalId,
        external,
        district: m.district,
        slug: m.slug,
        // Unicode already: no conversion step. Compose takes "converted" stories next.
        status: failed ? "failed" : "converted",
        sourceText: m.sourceText,
        sourceCharset: "utf-8",
        sourceEncoding: "unicode",
        headline: m.headline || null,
        body: m.body,
        parseMethod: "samvadia",
        parseNote: m.parseNote,
        lastError: failed ? "Samvadia story has no headline or body" : null,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  // ─── Media ─────────────────────────────────────────────────────────────────

  /** Footage for new stories now, and for every recent Samvadia story every rescanMs. */
  async takeMedia(created: Story[], itemErrors: IngestError[] = []): Promise<number> {
    const { db, orgId } = this.deps;
    let targets: Story[] = created;
    if (this.now() - this.lastRescan >= this.deps.rescanMs) {
      this.lastRescan = this.now();
      const recent = await db
        .select()
        .from(stories)
        .where(and(eq(stories.orgId, orgId), eq(stories.source, "samvadia"), gte(stories.createdAt, sql`now() - make_interval(hours => ${PAIR_WINDOW_HOURS})`)))
        .limit(500);
      await this.refreshFootagePaths(recent);
      const ids = new Set(created.map((s) => s.id));
      targets = [...created, ...recent.filter((s) => !ids.has(s.id))];
    } else if (this.seen.size) {
      // Between rescans, keep watching stories whose files were not yet stable
      const pending = new Set([...this.seen.keys()].map((k) => k.split("|")[0]!));
      const missing = [...pending].filter((id) => !created.some((s) => s.id === id));
      if (missing.length) targets = [...created, ...(await db.select().from(stories).where(inArray(stories.id, missing)))];
    }

    let taken = 0;
    for (const story of targets) {
      try {
        taken += await this.mediaFor(story);
      } catch (err) {
        itemErrors.push({ at: new Date(this.now()).toISOString(), message: `Footage for ${story.slug}: ${String((err as Error)?.message ?? err).slice(0, 300)}`, storyId: story.id });
        this.deps.log.warn({ err, storyId: story.id, path: story.external?.footagePath }, "could not read footage; will try again");
      }
    }
    return taken;
  }

  /** Samvadia may find (or change) the footage folder, the priority or the category after the story went out. */
  private async refreshFootagePaths(recent: Story[]): Promise<void> {
    const byItem = new Map(recent.filter((s) => s.external).map((s) => [s.external!.itemId, s]));
    if (!byItem.size) return;
    for (const info of await this.deps.reader.footageFor([...byItem.keys()])) {
      for (const s of recent.filter((r) => r.external?.itemId === info.itemId)) {
        const priority = asPriority(info.priority);
        const category = asCategory(info.category);
        const was = s.external!;
        if (was.footagePath === info.footagePath && was.footageStatus === info.footageStatus && asPriority(was.priority) === priority && (was.category ?? null) === category) continue;
        const external = { ...was, footagePath: info.footagePath, footageStatus: info.footageStatus, priority, category };
        await this.deps.db.update(stories).set({ external, updatedAt: sql`now()` }).where(eq(stories.id, s.id));
        s.external = external;
      }
    }
  }

  private stable(storyId: string, f: FootageFile): boolean {
    const key = `${storyId}|${f.path}`;
    const sig = `${f.size}|${f.mtime?.getTime() ?? ""}`;
    if (f.mtime && this.now() - f.mtime.getTime() > SETTLED_MS) {
      this.seen.delete(key);
      return true;
    }
    const prev = this.seen.get(key);
    if (!prev || prev.sig !== sig) {
      this.seen.set(key, { sig, at: this.now() });
      return false;
    }
    if (this.now() - prev.at < STABLE_MS) return false;
    this.seen.delete(key);
    return true;
  }

  /** List one story's folder; copy (or record) each new file. Returns files taken. */
  async mediaFor(story: Story): Promise<number> {
    const { db, storage, footage, media, orgId, log } = this.deps;
    const path = story.external?.footagePath;
    if (!path) return 0;

    const listed = await footage.listStoryFolder(path);
    const files = listed
      .map((f) => ({ f, parts: slugParts(f.name) }))
      .filter(({ parts }) => media.types.includes(parts.ext) && (parts.kind === "image" || parts.kind === "video"))
      // Photos first
      .sort((a, b) => (a.parts.kind === b.parts.kind ? a.f.name.localeCompare(b.f.name) : a.parts.kind === "image" ? -1 : 1));
    if (!files.length) return 0;

    const existing = new Map(
      (await db.select().from(assets).where(and(eq(assets.storyId, story.id), inArray(assets.sourcePath, files.map(({ f }) => f.path))))).map((a) => [a.sourcePath!, a]),
    );

    let taken = 0;
    for (const { f, parts } of files) {
      const have = existing.get(f.path);
      const wantCopy = parts.kind === "image" || media.video;
      // Done already, unless it was a video only recorded and video copying is on now
      if (have && !(have.skipReason === "video_off" && wantCopy)) continue;
      if (!this.stable(story.id, f)) continue;

      let skipReason: "video_off" | "too_big" | null = null;
      let storageKey: string | null = null;
      if (!wantCopy) skipReason = "video_off";
      else if (f.size > media.maxBytes) skipReason = "too_big";
      else {
        const bytes = await footage.read(f.path, media.maxBytes);
        const sha = createHash("sha256").update(bytes).digest("hex");
        storageKey = `media/${story.id}/${sha.slice(0, 16)}.${parts.ext}`;
        await storage.put(storageKey, bytes, CONTENT_TYPES[parts.ext] ?? "application/octet-stream");
      }

      if (have) {
        await db.update(assets).set({ storageKey, skipReason, bytes: f.size }).where(eq(assets.id, have.id));
      } else {
        await db
          .insert(assets)
          .values({
            orgId, storyId: story.id, kind: parts.kind, slug: story.slug, seq: parts.seq, storageKey, attachedBy: "footage",
            sourcePath: f.path, fileName: posix.basename(f.name), bytes: f.size, skipReason,
          })
          .onConflictDoNothing();
      }
      taken += 1;
      log.info({ storyId: story.id, path: f.path, kind: parts.kind, bytes: f.size, copied: !!storageKey, skipReason }, "footage taken");
    }

    if (taken) await this.markAttached(story, taken);
    return taken;
  }

  private async markAttached(story: Story, count: number): Promise<void> {
    const { db, orgId } = this.deps;
    await db.transaction(async (tx) => {
      await tx.update(stories).set({ mediaState: "attached", updatedAt: sql`now()` }).where(eq(stories.id, story.id));
      const drafts = await tx.select({ id: postDrafts.id }).from(postDrafts).where(eq(postDrafts.storyId, story.id));
      // A brand-new story announces itself when its card is ready; this is for media that came later
      if (drafts.length) await notify(tx, orgId, { type: "media.attached", storyId: story.id, draftIds: drafts.map((d) => d.id), count });
    });
  }
}
