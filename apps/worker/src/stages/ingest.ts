// Ingest: watch the control-room share, and turn each new, finished file into a row.
//
// A file is taken only when two scans at least 2 s apart see the same size and mtime: at one file
// every 90 s, reading a half-saved Notepad file is otherwise a certainty. The sha256 is the
// dedupe key, so a re-save or a reused name never makes a second story. The raw bytes go to
// storage untouched, so a converter fix can reprocess the archive later.
//
// The breaking share (layout "breaking", phase 1) is told apart by path, not by time: a file copied into a
// day folder keeps its old mtime, so "older than the watermark" proves nothing there. A path is done when
// ingested_files already has it at the same size and mtime, or when it was on the share at the very first
// start (the snapshot). The same path saved again with new text rewrites its story (or, once posted, makes
// a new one flagged as an update) instead of becoming an unrelated second story.

import { createHash } from "node:crypto";
import { slugParts } from "@socia/core";
import { assets, attachWaitingAssets, getKv, ingestedFiles, postDrafts, setKv, stories, storyForSlug, type Db, type Tx } from "@socia/db";
import type { FileSource, RemoteFile, Storage } from "@socia/providers";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";

const WATERMARK_KEY = "ingest.watermark";
/** Breaking share: the paths (and their size|mtime) that were there at the very first start, never taken */
const FIRST_START_KEY = "ingest.first_start";
/** Files older than the watermark by this much were handled before the last restart */
const WATERMARK_GRACE_MS = 10 * 60 * 1000;
const STABLE_MS = 2000;
/** Draft states that went (or are going) out: a re-saved file makes a new draft instead of rewriting these */
const SENT = ["published", "recalled", "queued", "publishing"];

const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", mxf: "application/mxf", mkv: "video/x-matroska", m4v: "video/mp4",
};

interface Seen {
  sig: string;
  at: number;
}

export interface IngestDeps {
  db: Db;
  storage: Storage;
  source: FileSource;
  orgId: string;
  log: Logger;
  now?: () => number;
  /** "breaking": the newsroom's breaking share (phase 1); stories are marked so convert/compose use its rules */
  layout?: "breaking";
  /**
   * On the very first start (nothing recorded yet), skip every file already there and take only files that
   * arrive after. Without it the first start takes the whole share, as before.
   */
  startFromNow?: boolean;
}

const sigOf = (f: RemoteFile) => `${f.size}|${f.mtime?.getTime() ?? ""}`;

export class Ingest {
  private readonly waiting = new Map<string, Seen>();
  private readonly handled = new Map<string, string>();
  private watermark: number | null | undefined;
  /** Breaking share: path → sig of what was there at the first start; null when there is no snapshot */
  private firstStart: Record<string, string> | null | undefined;

  constructor(private readonly deps: IngestDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get breaking(): boolean {
    return this.deps.layout === "breaking";
  }

  /** One scan of the share. Returns the number of files ingested. */
  async scan(): Promise<number> {
    const { db, source, log } = this.deps;
    if (this.watermark === undefined) {
      const saved = await getKv<{ mtime: string }>(db, WATERMARK_KEY);
      this.watermark = saved ? Date.parse(saved.mtime) : null;
    }

    const files = (await source.list()).sort((a, b) => (a.mtime?.getTime() ?? 0) - (b.mtime?.getTime() ?? 0));
    // The share moves to a new day folder every night: forget paths that are no longer listed
    const listed = new Set(files.map((f) => f.path));
    for (const map of [this.handled, this.waiting]) for (const path of map.keys()) if (!listed.has(path)) map.delete(path);

    if (this.breaking && (await this.firstStartSnapshot(files))) return 0;
    const known = this.breaking ? await this.knownPaths(files) : new Map<string, string>();

    let ingested = 0;
    let newest = this.watermark ?? 0;

    for (const file of files) {
      const sig = sigOf(file);
      if (this.handled.get(file.path) === sig) continue;
      if (this.breaking) {
        // Done before (recorded at this size and time), or on the share at the first start
        if (known.get(file.path) === sig || this.firstStart?.[file.path] === sig) {
          this.handled.set(file.path, sig);
          continue;
        }
      } else if (this.watermark && file.mtime && file.mtime.getTime() < this.watermark - WATERMARK_GRACE_MS) {
        this.handled.set(file.path, sig);
        continue;
      }

      const seen = this.waiting.get(file.path);
      if (!seen || seen.sig !== sig) {
        this.waiting.set(file.path, { sig, at: this.now() });
        continue;
      }
      if (this.now() - seen.at < STABLE_MS) continue;

      this.waiting.delete(file.path);
      try {
        if (await this.ingestFile(file)) ingested += 1;
        this.handled.set(file.path, sig);
        newest = Math.max(newest, file.mtime?.getTime() ?? 0);
      } catch (err) {
        log.error({ err, path: file.path }, "could not ingest file; will try again next scan");
      }
    }

    if (newest && newest !== this.watermark) {
      this.watermark = newest;
      await setKv(db, WATERMARK_KEY, { mtime: new Date(newest).toISOString() });
    }
    return ingested;
  }

  /**
   * Breaking share, first start (nothing recorded yet): remember every path on the share now, by the share's
   * own clock (size|mtime), and take none of them. True when this scan was that first one. Later starts load
   * the snapshot; it is dropped once none of its paths is listed any more (two days on).
   */
  private async firstStartSnapshot(files: RemoteFile[]): Promise<boolean> {
    const { db, log } = this.deps;
    if (this.firstStart === undefined) {
      const saved = await getKv<{ at: string; paths: Record<string, string> }>(db, FIRST_START_KEY);
      this.firstStart = saved?.paths ?? null;
      if (!saved && this.watermark === null && this.deps.startFromNow) {
        const paths = Object.fromEntries(files.map((f) => [f.path, sigOf(f)]));
        const newest = files.reduce((m, f) => Math.max(m, f.mtime?.getTime() ?? 0), 0);
        await setKv(db, FIRST_START_KEY, { at: new Date(this.now()).toISOString(), paths });
        // Marks "not a first start" for the next restart; the share's newest file time, not this machine's clock
        this.watermark = newest || this.now();
        await setKv(db, WATERMARK_KEY, { mtime: new Date(this.watermark).toISOString() });
        this.firstStart = paths;
        for (const f of files) this.handled.set(f.path, sigOf(f));
        log.info({ skipped: files.length }, "first start: files already on the share are skipped; taking only new ones");
        return true;
      }
    }
    if (this.firstStart && !files.some((f) => this.firstStart![f.path] !== undefined)) {
      this.firstStart = null;
      await setKv(db, FIRST_START_KEY, { at: new Date(this.now()).toISOString(), paths: {} });
    }
    return false;
  }

  /** Paths of this listing already in ingested_files, with the size|mtime they were taken at (newest row) */
  private async knownPaths(files: RemoteFile[]): Promise<Map<string, string>> {
    const ask = files.filter((f) => this.handled.get(f.path) !== sigOf(f)).map((f) => f.path);
    const out = new Map<string, string>();
    for (let i = 0; i < ask.length; i += 500) {
      const rows = await this.deps.db
        .selectDistinctOn([ingestedFiles.sourcePath], { path: ingestedFiles.sourcePath, bytes: ingestedFiles.bytes, mtime: ingestedFiles.mtime })
        .from(ingestedFiles)
        .where(and(eq(ingestedFiles.orgId, this.deps.orgId), inArray(ingestedFiles.sourcePath, ask.slice(i, i + 500))))
        .orderBy(ingestedFiles.sourcePath, desc(ingestedFiles.ingestedAt));
      for (const r of rows) out.set(r.path, `${r.bytes}|${r.mtime?.getTime() ?? ""}`);
    }
    return out;
  }

  /** Returns false when the bytes were already ingested (same sha256). */
  async ingestFile(file: RemoteFile): Promise<boolean> {
    const { db, storage, source, orgId, log } = this.deps;
    const bytes = await source.read(file.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const [dupe] = await db.select({ id: ingestedFiles.id }).from(ingestedFiles).where(and(eq(ingestedFiles.orgId, orgId), eq(ingestedFiles.sha256, sha256)));
    if (dupe) {
      // Same bytes saved again (only the time changed): record the new size|time so the path counts as done
      if (this.breaking) await db.update(ingestedFiles).set({ mtime: file.mtime, sourcePath: file.path }).where(and(eq(ingestedFiles.id, dupe.id), eq(ingestedFiles.sourcePath, file.path)));
      return false;
    }

    const parts = slugParts(file.name);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const storageKey = `raw/${day}/${sha256}${parts.ext ? `.${parts.ext}` : ""}`;
    await storage.put(storageKey, bytes, CONTENT_TYPES[parts.ext] ?? "application/octet-stream");

    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(ingestedFiles)
        .values({ orgId, sha256, sourcePath: file.path, fileName: file.name, bytes: bytes.length, mtime: file.mtime, storageKey, kind: parts.kind, slug: parts.slug, seq: parts.seq })
        .onConflictDoNothing()
        .returning();
      if (!row) return false;

      if (parts.kind === "text" && this.breaking) {
        await this.breakingStory(tx, row.id, file, parts.slug);
      } else if (parts.kind === "text") {
        const [story] = await tx.insert(stories).values({ orgId, fileId: row.id, slug: parts.slug }).returning();
        const attached = await attachWaitingAssets(tx, { id: story!.id, orgId, slug: parts.slug });
        log.info({ storyId: story!.id, slug: parts.slug, path: file.path, attached }, "story ingested");
      } else if (parts.kind === "image" || parts.kind === "video") {
        const story = await storyForSlug(tx, orgId, parts.slug);
        await tx.insert(assets).values({ orgId, fileId: row.id, storyId: story?.id ?? null, kind: parts.kind, slug: parts.slug, seq: parts.seq, storageKey, attachedBy: story ? "auto" : null });
        if (story) await tx.update(stories).set({ mediaState: "attached" }).where(eq(stories.id, story.id));
        log.info({ slug: parts.slug, path: file.path, storyId: story?.id ?? null }, "media ingested");
      }
      return true;
    });
  }

  /**
   * A breaking file's story. New path: a new story. The same path saved with new text: its story goes back
   * through convert and compose and rewrites its unposted draft ("resaved"); if that draft already went out,
   * a new story is made, flagged "update_of_posted" and linked to the posted draft.
   */
  private async breakingStory(tx: Tx, fileId: string, file: RemoteFile, slug: string): Promise<void> {
    const { orgId, log } = this.deps;
    const [prev] = await tx
      .select({ id: stories.id, needsCheck: stories.needsCheck })
      .from(stories)
      .innerJoin(ingestedFiles, eq(ingestedFiles.id, stories.fileId))
      .where(and(eq(stories.orgId, orgId), eq(ingestedFiles.sourcePath, file.path), eq(stories.layout, "breaking"), sql`${ingestedFiles.id} <> ${fileId}`))
      .orderBy(desc(stories.createdAt))
      .limit(1)
      .for("update", { of: stories });
    const [draft] = prev ? await tx.select({ id: postDrafts.id, status: postDrafts.status }).from(postDrafts).where(eq(postDrafts.storyId, prev.id)) : [];

    if (prev && !(draft && SENT.includes(draft.status))) {
      const needsCheck = [...new Set([...prev.needsCheck.filter((c) => c === "update_of_posted"), "resaved"])];
      await tx.update(stories).set({ fileId, status: "ingested", needsCheck, lastError: null, updatedAt: sql`now()` }).where(eq(stories.id, prev.id));
      log.info({ storyId: prev.id, draftId: draft?.id ?? null, path: file.path }, "breaking file saved again: its story is re-read");
      return;
    }
    const [story] = await tx
      .insert(stories)
      .values({
        orgId, fileId, slug, layout: "breaking", mediaState: "none",
        ...(draft && { needsCheck: ["update_of_posted"], updateOfDraftId: draft.id }),
      })
      .returning({ id: stories.id });
    log.info({ storyId: story!.id, path: file.path, updateOf: draft?.id ?? null }, draft ? "breaking file saved again after posting: new story" : "breaking story ingested");
  }
}
