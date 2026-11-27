// The learn role (step 6, README §3 step 7): what the desk posted goes into the directory. Every 10 minutes, posts
// whose undo window has passed are added to the desk's own post list (desk-posts.jsonl, the same form as the #FINVideo
// captures) and directory/build.py rebuilds format, tags, handles and counts from both. It also rebuilds when the
// committed inputs changed (new captures, build.py, the breaking desk's directory), so a quiet desk never keeps a
// stale directory.
//
// Each build is a whole new folder under <XVIDEOS_CACHE>/directory/builds; when it succeeded, the one-line file
// <XVIDEOS_CACHE>/directory/current is switched to it in a single rename, so the api's composer (src/compose) always
// reads one complete build, never a mix. A failed build changes nothing and gives its posts back for the next round.
// A post is taken once (marked in the same statement that takes it) and written to the list once (by its id), so a
// failure halfway never counts a post twice. The committed directory (apps/xvideos/directory) is never written.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type { Db } from "@socia/db";
import type { Logger } from "pino";
import { xvReleasePosts, xvTakePostsToLearn } from "../db/clips";
import type { XvPostRow } from "../db/schema";

/** The files build.py writes */
export const XV_DIRECTORY_BUILT = ["format.json", "tags.json", "handles.json", "counts.json"] as const;
/** A post is learned once it can no longer be undone (the api's XV_UNDO_S, 6 min) and a minute more */
export const XV_LEARN_AFTER_S = 7 * 60;
/** Builds kept besides the current one (to look back at; older ones are removed) */
const KEEP_BUILDS = 3;
const BUILD_TIMEOUT_MS = 120_000;
const DESK_POSTS = "desk-posts.jsonl";

export interface XvLearnPaths {
  /** Python 3 (build.py uses only its standard library) */
  python: string;
  /** apps/xvideos/directory/build.py */
  buildScript: string;
  /** The committed #FINVideo captures (apps/xvideos/directory/data/finvideo-posts.jsonl) */
  posts: string;
  /** Files whose change means the learned directory is out of date (the captures, build.py, the breaking desk's files) */
  inputs: readonly string[];
  /** <XVIDEOS_CACHE>/directory */
  outDir: string;
}

/** The current learned build's folder (with a trailing separator), or null when learn has built none yet */
export function xvLearnedDir(outDir: string): string | null {
  try {
    const name = readFileSync(join(outDir, "current"), "utf8").trim();
    if (!/^[\w.-]+$/.test(name)) return null;
    const dir = join(outDir, "builds", name);
    return XV_DIRECTORY_BUILT.every((f) => existsSync(join(dir, f))) ? `${dir}${sep}` : null;
  } catch {
    return null;
  }
}

/** "2026-11-27 15:04", IST, as the captures write it */
export function xvIstStamp(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

/** One posted decision as a line of desk-posts.jsonl */
export function xvLearnRecord(p: Pick<XvPostRow, "id" | "clipId" | "at" | "text">): string {
  return JSON.stringify({ post_id: `desk-${p.id}`, posted_ist: xvIstStamp(p.at), text: p.text ?? "", source: "desk", clip_id: p.clipId });
}

/** The post ids already in a desk-posts.jsonl text */
function idsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as { post_id?: unknown }).post_id;
      if (typeof id === "string") ids.add(id);
    } catch {
      // a broken line is left as it is; build.py reports it
    }
  }
  return ids;
}

export type XvBuild = (python: string, args: string[]) => Promise<void>;
const execBuild: XvBuild = async (python, args) => {
  await promisify(execFile)(python, args, { timeout: BUILD_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
};

export class XvLearnStep {
  private nextRun = 0;

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly paths: XvLearnPaths,
    private readonly log: Logger,
    private readonly everyMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly build: XvBuild = execBuild,
  ) {}

  /** A committed input is newer than the current build (or there is none yet) */
  private stale(current: string | null): boolean {
    if (!current) return true;
    const built = statSync(join(current, "tags.json")).mtimeMs;
    return this.paths.inputs.some((f) => existsSync(f) && statSync(f).mtimeMs > built);
  }

  async tick(): Promise<boolean> {
    if (this.now() < this.nextRun) return false;
    this.nextRun = this.now() + this.everyMs;
    const { outDir } = this.paths;
    const current = xvLearnedDir(outDir);
    const posts = await xvTakePostsToLearn(this.db, this.orgId, XV_LEARN_AFTER_S);
    if (!posts.length && !this.stale(current)) return false;

    const name = `${new Date(this.now()).toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
    const dir = join(outDir, "builds", name);
    try {
      await mkdir(dir, { recursive: true });
      const before = current && existsSync(join(current, DESK_POSTS)) ? await readFile(join(current, DESK_POSTS), "utf8") : "";
      const known = idsIn(before);
      // Blank posts are taken and skipped for good; a post already in the list is never written twice
      const add = posts.filter((p) => p.text?.trim() && !known.has(`desk-${p.id}`)).map(xvLearnRecord);
      const list = join(dir, DESK_POSTS);
      await writeFile(list, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${add.map((l) => `${l}\n`).join("")}`, "utf8");
      await this.build(this.paths.python, [this.paths.buildScript, "--posts", this.paths.posts, "--extra-posts", list, "--out", dir]);
      if (!XV_DIRECTORY_BUILT.every((f) => existsSync(join(dir, f)))) throw new Error("build.py did not write every file");
      // The switch: one rename of a one-line file
      await writeFile(join(outDir, "current.tmp"), name, "utf8");
      await rename(join(outDir, "current.tmp"), join(outDir, "current"));
      await this.prune(name);
      this.log.info({ posts: add.length, build: name }, posts.length ? "x videos directory learned the desk's posts" : "x videos directory rebuilt (its inputs changed)");
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      const e = err as Error & { stderr?: string };
      this.log.warn({ err: (e.stderr || e.message || String(err)).slice(-400) }, "x videos learn failed; its posts wait for the next round");
      await xvReleasePosts(
        this.db,
        posts.map((p) => p.id),
      ).catch((release) => this.log.error({ err: (release as Error).message, posts: posts.map((p) => p.id) }, "x videos learn could not give its posts back; they stay unlearned"));
    }
    return true;
  }

  /** Removes all but the newest KEEP_BUILDS builds besides `keep` */
  private async prune(keep: string): Promise<void> {
    const root = join(this.paths.outDir, "builds");
    const old = readdirSync(root)
      .filter((n) => n !== keep)
      .sort()
      .reverse()
      .slice(KEEP_BUILDS);
    for (const n of old) await rm(join(root, n), { recursive: true, force: true }).catch(() => undefined);
  }
}
