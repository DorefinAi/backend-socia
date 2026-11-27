// Step 6's learn role: the desk's posts into the directory (database mocked; one real build.py run).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { xvReleasePosts, xvTakePostsToLearn } from "../src/db/clips";
import type { XvPostRow } from "../src/db/schema";
import { XV_DIRECTORY_BUILT, XvLearnStep, xvIstStamp, xvLearnRecord, xvLearnedDir, type XvBuild } from "../src/worker/learn";

vi.mock("../src/db/clips", async (orig) => ({
  ...(await orig<typeof import("../src/db/clips")>()),
  xvTakePostsToLearn: vi.fn(),
  xvReleasePosts: vi.fn(),
}));

const DIRECTORY = fileURLToPath(new URL("../directory/", import.meta.url));
const PYTHON = process.env.XVIDEOS_PYTHON?.trim() || "python";
const tmp = mkdtempSync(join(tmpdir(), "xv-learn-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const post = (id: number, text: string, at = new Date("2026-11-27T09:00:00Z")) => ({ id, clipId: `c${id}`, at, text }) as XvPostRow;
const hasPython = (() => {
  try {
    execFileSync(PYTHON, ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

/** A stand-in for build.py: writes every file, with the desk posts it was given */
const fakeBuild: XvBuild = async (_python, args) => {
  const out = args[args.indexOf("--out") + 1]!;
  const extra = readFileSync(args[args.indexOf("--extra-posts") + 1]!, "utf8");
  for (const f of XV_DIRECTORY_BUILT) writeFileSync(join(out, f), JSON.stringify({ built: f, desk: extra.trim().split("\n").filter(Boolean).length }));
};

describe("learn records", () => {
  it("writes a post as the captures do, with the IST time", () => {
    expect(xvIstStamp(new Date("2026-11-27T09:00:00Z"))).toBe("2026-11-27 14:30");
    expect(JSON.parse(xvLearnRecord(post(7, "हेडलाइन\n#FINVideo")))).toEqual({ post_id: "desk-7", posted_ist: "2026-11-27 14:30", text: "हेडलाइन\n#FINVideo", source: "desk", clip_id: "c7" });
  });
});

describe("the learn role", () => {
  let n = 0;
  let clock = Date.parse("2026-11-27T12:00:00Z");
  const outDir = () => join(tmp, `out-${++n}`);
  const step = (dir: string, build: XvBuild, inputs: string[] = []) =>
    new XvLearnStep({} as never, "org", { python: PYTHON, buildScript: "b.py", posts: "p.jsonl", inputs, outDir: dir }, log, 0, () => (clock += 1000), build);
  const deskLines = (dir: string) => readFileSync(join(xvLearnedDir(dir)!, "desk-posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).post_id as string);
  beforeEach(() => {
    vi.mocked(xvTakePostsToLearn).mockReset().mockResolvedValue([]);
    vi.mocked(xvReleasePosts).mockReset().mockResolvedValue();
    vi.mocked(log.warn).mockClear();
  });

  it("waits between rounds", async () => {
    let now = 0;
    const s = new XvLearnStep({} as never, "org", { python: PYTHON, buildScript: "b.py", posts: "p.jsonl", inputs: [], outDir: outDir() }, log, 600_000, () => now, vi.fn());
    await s.tick();
    now = 1000;
    expect(await s.tick()).toBe(false);
    expect(xvTakePostsToLearn).toHaveBeenCalledTimes(1);
  });

  it("builds a whole new folder and switches to it in one step; later rounds add to the list, once per post", async () => {
    const dir = outDir();
    const s = step(dir, fakeBuild);
    vi.mocked(xvTakePostsToLearn).mockResolvedValue([post(1, "पहली पोस्ट #FINVideo"), post(2, "  ")]);
    expect(await s.tick()).toBe(true);
    const first = xvLearnedDir(dir)!;
    expect(XV_DIRECTORY_BUILT.every((f) => existsSync(join(first, f)))).toBe(true);
    expect(deskLines(dir)).toEqual(["desk-1"]);

    // Post 1 comes again (taken twice by a hand-reset): written once; post 3 is new
    vi.mocked(xvTakePostsToLearn).mockResolvedValue([post(1, "पहली पोस्ट #FINVideo"), post(3, "तीसरी")]);
    await s.tick();
    expect(xvLearnedDir(dir)).not.toBe(first);
    expect(deskLines(dir)).toEqual(["desk-1", "desk-3"]);
    expect(JSON.parse(readFileSync(join(xvLearnedDir(dir)!, "tags.json"), "utf8")).desk).toBe(2);
  });

  it("rebuilds without posts when an input is newer than the build, else does nothing", async () => {
    const dir = outDir();
    const input = join(tmp, `input-${n}.json`);
    writeFileSync(input, "{}");
    utimesSync(input, new Date(0), new Date(0));
    const build = vi.fn(fakeBuild);
    const s = step(dir, build, [input]);
    await s.tick();
    expect(build).toHaveBeenCalledTimes(1);
    await s.tick();
    expect(build).toHaveBeenCalledTimes(1);
    utimesSync(input, new Date(), new Date(Date.now() + 60_000));
    await s.tick();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("a failed build changes nothing and gives its posts back", async () => {
    const dir = outDir();
    const s = step(dir, fakeBuild);
    vi.mocked(xvTakePostsToLearn).mockResolvedValue([post(1, "पोस्ट")]);
    await s.tick();
    const before = xvLearnedDir(dir);
    const failing = step(dir, async () => {
      throw Object.assign(new Error("exit 1"), { stderr: "Traceback: bad json" });
    });
    vi.mocked(xvTakePostsToLearn).mockResolvedValue([post(2, "दूसरी")]);
    await failing.tick();
    expect(xvLearnedDir(dir)).toBe(before);
    expect(deskLines(dir)).toEqual(["desk-1"]);
    expect(vi.mocked(xvReleasePosts).mock.calls.at(-1)?.[1]).toEqual([2]);
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toMatchObject({ err: "Traceback: bad json" });
    expect(readdirSync(join(dir, "builds"))).toHaveLength(1);
  });

  it("keeps the newest builds only", async () => {
    const dir = outDir();
    const s = step(dir, fakeBuild);
    for (let i = 1; i <= 6; i++) {
      vi.mocked(xvTakePostsToLearn).mockResolvedValue([post(i, `पोस्ट ${i}`)]);
      await s.tick();
    }
    expect(readdirSync(join(dir, "builds"))).toHaveLength(4);
    expect(deskLines(dir)).toHaveLength(6);
  });

  it.skipIf(!hasPython)("with the real build.py: a tag the desk used twice joins the directory", async () => {
    const dir = outDir();
    const s = new XvLearnStep({} as never, "org", { python: PYTHON, buildScript: `${DIRECTORY}build.py`, posts: `${DIRECTORY}data/finvideo-posts.jsonl`, inputs: [], outDir: dir }, log, 0, () => 0);
    vi.mocked(xvTakePostsToLearn).mockResolvedValue([
      post(1, "टेस्ट खबर एक | Jaipur News\n#RajasthanWithFirstIndia #FINVideo #DeskLearnTest", new Date("2026-11-28T06:00:00Z")),
      post(2, "टेस्ट खबर दो | Jaipur News\n#RajasthanWithFirstIndia #FINVideo #DeskLearnTest", new Date("2026-11-28T07:00:00Z")),
    ]);
    expect(await s.tick()).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    const tags = JSON.parse(readFileSync(join(xvLearnedDir(dir)!, "tags.json"), "utf8")) as { entries: { tag: string; uses: number }[]; built_from: { posts: number } };
    expect(tags.entries.find((t) => t.tag === "#DeskLearnTest")?.uses).toBe(2);
    const committed = readFileSync(`${DIRECTORY}data/finvideo-posts.jsonl`, "utf8").split("\n").filter((l) => l.trim()).length;
    expect(tags.built_from.posts).toBe(committed + 2);
  }, 60_000);
});
