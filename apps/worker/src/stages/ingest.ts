// Ingest: watch the control-room share, and turn each new, finished file into a row.
//
// A file is taken only when two scans at least 2 s apart see the same size and mtime: at one file
// every 90 s, reading a half-saved Notepad file is otherwise a certainty. The sha256 is the
// dedupe key, so a re-save or a reused name never makes a second story. The raw bytes go to
// storage untouched, so a converter fix can reprocess the archive later.

import { createHash } from "node:crypto";
import { slugParts } from "@socia/core";
import { assets, attachWaitingAssets, getKv, ingestedFiles, setKv, stories, storyForSlug, type Db } from "@socia/db";
import type { FileSource, RemoteFile, Storage } from "@socia/providers";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";

const WATERMARK_KEY = "ingest.watermark";
/** Files older than the watermark by this much were handled before the last restart */
const WATERMARK_GRACE_MS = 10 * 60 * 1000;
const STABLE_MS = 2000;

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
}

export class Ingest {
  private readonly waiting = new Map<string, Seen>();
  private readonly handled = new Map<string, string>();
  private watermark: number | null | undefined;

  constructor(private readonly deps: IngestDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One scan of the share. Returns the number of files ingested. */
  async scan(): Promise<number> {
    const { db, source, log } = this.deps;
    if (this.watermark === undefined) {
      const saved = await getKv<{ mtime: string }>(db, WATERMARK_KEY);
      this.watermark = saved ? Date.parse(saved.mtime) : null;
    }

    const files = (await source.list()).sort((a, b) => (a.mtime?.getTime() ?? 0) - (b.mtime?.getTime() ?? 0));
    let ingested = 0;
    let newest = this.watermark ?? 0;

    for (const file of files) {
      const sig = `${file.size}|${file.mtime?.getTime() ?? ""}`;
      if (this.handled.get(file.path) === sig) continue;
      if (this.watermark && file.mtime && file.mtime.getTime() < this.watermark - WATERMARK_GRACE_MS) {
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

  /** Returns false when the bytes were already ingested (same sha256). */
  async ingestFile(file: RemoteFile): Promise<boolean> {
    const { db, storage, source, orgId, log } = this.deps;
    const bytes = await source.read(file.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const [dupe] = await db.select({ id: ingestedFiles.id }).from(ingestedFiles).where(and(eq(ingestedFiles.orgId, orgId), eq(ingestedFiles.sha256, sha256)));
    if (dupe) return false;

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

      if (parts.kind === "text") {
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
}
