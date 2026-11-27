import { join } from "node:path";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { xvLiveMonths, xvMarkGone, xvMarkGoneDays, xvRecordScan, xvTakeScanRequests } from "../src/db/clips";
import { parseProbe, posterAt, toolError } from "../src/worker/probe";
import { parseReadAnswer, xvEvidenceOf } from "../src/worker/read";
import { XvShareReader, XvShareUnreachable, type XvShareFs } from "../src/worker/share";
import { XvWatcher } from "../src/worker/watch";

vi.mock("../src/db/clips", async (orig) => ({
  ...(await orig<typeof import("../src/db/clips")>()),
  xvRecordScan: vi.fn(),
  xvMarkGone: vi.fn(),
  xvMarkGoneDays: vi.fn(),
  xvTakeScanRequests: vi.fn(),
  xvLiveMonths: vi.fn(),
}));

const ROOT = "S:\\share";
const month = { year: "2026", month: "NOVEMBER 2026" };

/** A fake share: folders map to entries; files map to [size, mtime ms] */
function fakeFs(tree: Record<string, string[]>, files: Record<string, [number, number]>, failing: string[] = []): XvShareFs {
  const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isFile: () => !dir });
  return {
    async readdir(path) {
      if (failing.includes(path)) throw Object.assign(new Error("io"), { code: "EIO" });
      const entries = tree[path];
      if (!entries) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return entries.map((e) => dirent(e.replace(/\/$/, ""), e.endsWith("/")));
    },
    async stat(path) {
      const f = files[path];
      if (!f) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { size: f[0], mtime: new Date(f[1]) };
    },
  };
}

const p = (...parts: string[]) => join(ROOT, ...parts);

describe("XvShareReader", () => {
  const dayFolder = ["2026", "November 2026", "24-11-2026"];
  const tree = {
    [ROOT]: ["2026/", "logo2/"],
    [p("2026")]: ["November 2026/", "August 2026/"],
    [p("2026", "November 2026")]: ["24-11-2026/", "23-11-2026/", "old stuff/", "notes.txt"],
    [p("2026", "November 2026", "24-11-2026")]: ["Convert 3 pm/", "loose.png", "x...JO.mp4"],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm")]: ["x...done......Kota News.mp4", "New folder/", "a.mpg.ese2"],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm", "New folder")]: ["deep.mkv"],
  };
  const files = {
    [p("2026", "November 2026", "24-11-2026", "x...JO.mp4")]: [100, 1000] as [number, number],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm", "x...done......Kota News.mp4")]: [200, 2000] as [number, number],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm", "New folder", "deep.mkv")]: [300, 3000] as [number, number],
  };

  it("lists a month's day folders, month matched without case, newest first, non-date folders left out", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files));
    expect(await r.listMonth({ year: "2026", month: "NOVEMBER 2026" })).toEqual({
      monthFolder: ["2026", "November 2026"],
      days: [
        { folder: ["2026", "November 2026", "24-11-2026"], name: "24-11-2026", day: "2026-11-24" },
        { folder: ["2026", "November 2026", "23-11-2026"], name: "23-11-2026", day: "2026-11-23" },
      ],
    });
    expect(await r.listMonth({ year: "2026", month: "DECEMBER 2026" })).toEqual({ monthFolder: null, days: [] });
  });

  it("finds every video of a day at any depth", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files));
    const out = await r.listDay(dayFolder);
    expect(out.complete).toBe(true);
    expect(out.files.map((f) => [f.folder.slice(3).join("/"), f.fileName, f.size]).sort((a, b) => Number(a[2]) - Number(b[2]))).toEqual([
      ["", "x...JO.mp4", 100],
      ["Convert 3 pm", "x...done......Kota News.mp4", 200],
      ["Convert 3 pm/New folder", "deep.mkv", 300],
    ]);
  });

  it("says a day folder deleted from the share is empty and complete (its clips go)", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files));
    expect(await r.listDay(["2026", "November 2026", "25-11-2026"])).toEqual({ files: [], complete: true });
  });

  it("marks the listing incomplete when an inner folder cannot be read", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files, [p("2026", "November 2026", "24-11-2026", "Convert 3 pm")]));
    const out = await r.listDay(dayFolder);
    expect(out.complete).toBe(false);
    expect(out.files.map((f) => f.fileName)).toEqual(["x...JO.mp4"]);
  });

  it("marks the listing incomplete when a listed file is gone by its stat (renamed mid-scan)", async () => {
    const renamed = { ...files };
    delete renamed[p("2026", "November 2026", "24-11-2026", "x...JO.mp4")];
    const out = await new XvShareReader(ROOT, fakeFs(tree, renamed)).listDay(dayFolder);
    expect(out.complete).toBe(false);
    expect(out.files).toHaveLength(2);
  });

  it("marks the listing incomplete when an inner folder is renamed mid-scan", async () => {
    const moved = { ...tree };
    delete moved[p("2026", "November 2026", "24-11-2026", "Convert 3 pm", "New folder")];
    expect((await new XvShareReader(ROOT, fakeFs(moved, files)).listDay(dayFolder)).complete).toBe(false);
  });

  it("reports the share as unreachable when the root or a day folder cannot be read", async () => {
    await expect(new XvShareReader(ROOT, fakeFs(tree, files, [ROOT])).listMonth(month)).rejects.toBeInstanceOf(XvShareUnreachable);
    await expect(new XvShareReader(ROOT, fakeFs(tree, files, [p(...dayFolder)])).listDay(dayFolder)).rejects.toBeInstanceOf(XvShareUnreachable);
  });

  it("times out a hung share call, and stops at the first day folder", async () => {
    const hung: XvShareFs = { readdir: () => new Promise(() => undefined), stat: () => new Promise(() => undefined) };
    await expect(new XvShareReader(ROOT, hung, 20).listMonth(month)).rejects.toBeInstanceOf(XvShareUnreachable);
    await expect(new XvShareReader(ROOT, hung, 20).listDay(dayFolder)).rejects.toBeInstanceOf(XvShareUnreachable);
  });
});

describe("XvWatcher", () => {
  const NOV = p("2026", "NOVEMBER 2026");
  const TODAY_DIR = p("2026", "NOVEMBER 2026", "27-11-2026", "Convert 1 pm to-");
  const HEADING_FILE = "SI भर्ती पेपर लीक प्रकरण में इनामी श्रीराम बिश्नोई गिरफ्तार  Jaipur News.mp4";
  /** A share with 26 and 27 Nov; returned objects can be changed between ticks */
  const share = () => {
    const tree: Record<string, string[]> = {
      [ROOT]: ["2026/"],
      [p("2026")]: ["NOVEMBER 2026/"],
      [NOV]: ["27-11-2026/", "26-11-2026/"],
      [p("2026", "NOVEMBER 2026", "27-11-2026")]: ["Convert 1 pm to-/"],
      [TODAY_DIR]: [HEADING_FILE, "X...Bikaner.mp4"],
      [p("2026", "NOVEMBER 2026", "26-11-2026")]: ["old.mp4"],
    };
    const files: Record<string, [number, number]> = {
      [p("2026", "NOVEMBER 2026", "27-11-2026", "Convert 1 pm to-", HEADING_FILE)]: [10, 1],
      [p("2026", "NOVEMBER 2026", "27-11-2026", "Convert 1 pm to-", "X...Bikaner.mp4")]: [20, 2],
      [p("2026", "NOVEMBER 2026", "26-11-2026", "old.mp4")]: [30, 3],
    };
    const failing: string[] = [];
    return { tree, files, failing, reader: new XvShareReader(ROOT, fakeFs(tree, files, failing)) };
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const timing = { todayMs: 30_000, monthMs: 600_000, followUpMs: 10_000, settleMs: 10_000 };
  // 06:00 UTC = 11:30 IST on 27 Nov
  const start = new Date("2026-11-27T06:00:00Z").getTime();

  beforeEach(() => {
    vi.mocked(xvRecordScan).mockReset().mockResolvedValue({ inserted: 0, queued: 0 });
    vi.mocked(xvMarkGone).mockReset().mockResolvedValue(0);
    vi.mocked(xvMarkGoneDays).mockReset().mockResolvedValue(0);
    vi.mocked(xvTakeScanRequests).mockReset().mockResolvedValue([]);
    vi.mocked(xvLiveMonths).mockReset().mockResolvedValue([]);
    vi.mocked(log.error).mockClear();
  });

  /** Per recordScan call: the files it recorded as [day, name, picked, heading] */
  const recorded = () => vi.mocked(xvRecordScan).mock.calls.map((c) => c[2].map((f) => [f.day, f.fileName, f.picked, f.heading]));
  /** The day folders walked (one recordScan call per walk), in order */
  const walkedDays = () => vi.mocked(xvRecordScan).mock.calls.length;
  const watcher = (reader: XvShareReader, clock: { t: number }) => new XvWatcher({} as never, "org", reader, log, () => new Date(clock.t), timing);

  it("settles a file on the second walk of its day: every video, x-marked or not, with its heading", async () => {
    const clock = { t: start };
    const w = watcher(share().reader, clock);
    await w.tick(); // 1st: whole month, nothing settled yet
    clock.t += 10_000;
    await w.tick(); // 2nd: whole month again, everything settles
    expect(recorded().slice(-2)).toEqual([
      [
        ["2026-11-27", HEADING_FILE, false, "SI भर्ती पेपर लीक प्रकरण में इनामी श्रीराम बिश्नोई गिरफ्तार | Jaipur News"],
        ["2026-11-27", "X...Bikaner.mp4", true, null],
      ],
      [["2026-11-26", "old.mp4", false, null]],
    ]);
    expect(vi.mocked(xvMarkGone).mock.calls.at(-1)?.slice(2)).toEqual([["2026", "NOVEMBER 2026", "26-11-2026"], ["30:3"]]);
  });

  it("does not take a file still being copied: same size and time for 10 s first", async () => {
    const clock = { t: start };
    const s = share();
    const bikaner = p("2026", "NOVEMBER 2026", "27-11-2026", "Convert 1 pm to-", "X...Bikaner.mp4");
    const w = watcher(s.reader, clock);
    await w.tick();
    s.files[bikaner] = [25, 5]; // still growing
    clock.t += 10_000;
    await w.tick(); // 2nd start-up walk: 27 Nov, then 26 Nov
    expect(recorded().at(-2)?.map((f) => f[1])).toEqual([HEADING_FILE]);
    vi.mocked(xvRecordScan).mockClear();
    clock.t += 30_000;
    await w.tick(); // today again, 30 s on: the copy has stopped growing since the last walk
    expect(recorded()[0]?.map((f) => f[1])).toEqual([HEADING_FILE, "X...Bikaner.mp4"]);
  });

  it("walks today every 30 s and the whole month every 10 min, nothing in between", async () => {
    const clock = { t: start };
    const w = watcher(share().reader, clock);
    await w.tick();
    clock.t += 10_000;
    await w.tick();
    vi.mocked(xvRecordScan).mockClear();
    clock.t += 3000;
    await w.tick(); // nothing due
    expect(walkedDays()).toBe(0);
    clock.t += 30_000;
    await w.tick(); // today only
    expect(recorded().map((f) => f[0]?.[0])).toEqual(["2026-11-27"]);
    vi.mocked(xvRecordScan).mockClear();
    clock.t += 600_000;
    await w.tick(); // whole month
    expect(recorded().map((f) => f[0]?.[0])).toEqual(["2026-11-27", "2026-11-26"]);
  });

  it("walks a day the desk asked for at once, and again 10 s later so its new files settle", async () => {
    const clock = { t: start };
    const s = share();
    const w = watcher(s.reader, clock);
    await w.tick();
    clock.t += 10_000;
    await w.tick();
    // A new file lands in 26 Nov; the desk presses Refresh on 26 Nov
    s.tree[p("2026", "NOVEMBER 2026", "26-11-2026")] = ["old.mp4", "late.mp4"];
    s.files[p("2026", "NOVEMBER 2026", "26-11-2026", "late.mp4")] = [40, 4];
    vi.mocked(xvRecordScan).mockClear();
    vi.mocked(xvTakeScanRequests).mockResolvedValueOnce(["2026-11-26"]);
    clock.t += 3000;
    await w.tick(); // walks 26 Nov at once: late.mp4 seen for the first time
    expect(recorded()).toEqual([[["2026-11-26", "old.mp4", false, null]]]);
    clock.t += 3000;
    await w.tick(); // follow-up not due yet
    expect(walkedDays()).toBe(1);
    clock.t += 10_000;
    await w.tick(); // follow-up: late.mp4 settles
    expect(recorded().at(-1)?.map((f) => f[1])).toEqual(["old.mp4", "late.mp4"]);
  });

  it("keeps checking last month while it has clips on the desk, and takes them off when its folder is gone", async () => {
    // 10 Dec: only December is in the scan window; the desk still has November clips
    const clock = { t: new Date("2026-12-10T06:00:00Z").getTime() };
    const s = share();
    s.tree[p("2026")] = ["NOVEMBER 2026/", "DECEMBER 2026/"];
    s.tree[p("2026", "DECEMBER 2026")] = [];
    vi.mocked(xvLiveMonths).mockResolvedValue([["2026", "NOVEMBER 2026"]]);
    const w = watcher(s.reader, clock);
    await w.tick();
    expect(vi.mocked(xvMarkGoneDays).mock.calls.map((c) => c.slice(2))).toEqual([
      [["2026", "DECEMBER 2026"], []],
      [["2026", "NOVEMBER 2026"], ["27-11-2026", "26-11-2026"]],
    ]);
    // The share clears the November folder
    s.tree[p("2026")] = ["DECEMBER 2026/"];
    vi.mocked(xvMarkGoneDays).mockClear();
    clock.t += 10_000;
    await w.tick();
    expect(vi.mocked(xvMarkGoneDays).mock.calls.map((c) => c.slice(2))).toContainEqual([["2026", "NOVEMBER 2026"], []]);
  });

  it("on a share outage stops at once, logs once, and keeps a Refresh for after", async () => {
    const clock = { t: start };
    const s = share();
    const w = watcher(s.reader, clock);
    s.failing.push(p("2026", "NOVEMBER 2026", "27-11-2026"));
    vi.mocked(xvTakeScanRequests).mockResolvedValueOnce(["2026-11-26"]);
    await w.tick();
    clock.t += 10_000;
    await w.tick();
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
    expect(walkedDays()).toBe(0);
    // Back: the Refresh asked for during the outage is walked with the next pass
    s.failing.length = 0;
    clock.t += 10_000;
    await w.tick();
    expect(recorded().map((f) => f.length)).toEqual([0, 0]);
    expect(vi.mocked(xvMarkGone).mock.calls.map((c) => c[2][2])).toEqual(["27-11-2026", "26-11-2026"]);
  });

  it("tries a Refresh for a day with no folder (or a date the share never had) once more, then stops", async () => {
    const clock = { t: start };
    const s = share();
    const w = watcher(s.reader, clock);
    await w.tick();
    clock.t += 10_000;
    await w.tick();
    const listMonth = vi.spyOn(s.reader, "listMonth");
    vi.mocked(xvTakeScanRequests).mockResolvedValueOnce(["2026-11-28", "2020-01-01"]);
    clock.t += 3000;
    await w.tick(); // at once
    clock.t += 10_000;
    await w.tick(); // the one follow-up
    const calls = listMonth.mock.calls.length;
    expect(listMonth.mock.calls.map((c) => c[0].month)).toContain("JANUARY 2020");
    for (let i = 0; i < 5; i++) {
      clock.t += 3000;
      await w.tick(); // nothing due: today was walked 13 s ago
    }
    expect(listMonth.mock.calls.length).toBe(calls);
  });

  it("keeps a Refresh when the database fails mid-walk, and walks it on a later pass", async () => {
    const clock = { t: start };
    const s = share();
    const w = watcher(s.reader, clock);
    await w.tick();
    clock.t += 10_000;
    await w.tick();
    vi.mocked(xvTakeScanRequests).mockResolvedValueOnce(["2026-11-26"]);
    vi.mocked(xvRecordScan).mockRejectedValueOnce(new Error("db down"));
    clock.t += 3000;
    await expect(w.tick()).rejects.toThrow("db down");
    vi.mocked(xvRecordScan).mockClear();
    clock.t += 30_000;
    await w.tick();
    expect(recorded().map((f) => f[0]?.[0])).toContain("2026-11-26");
  });

  it("marks nothing gone in a day whose listing was cut short", async () => {
    const clock = { t: start };
    const s = share();
    s.failing.push(TODAY_DIR);
    const w = watcher(s.reader, clock);
    await w.tick();
    expect(vi.mocked(xvMarkGone).mock.calls.map((c) => c[2][2])).toEqual(["26-11-2026"]);
  });
});

describe("probe", () => {
  it("reads length, shape, codec and sound", () => {
    const json = JSON.stringify({
      format: { duration: "93.456" },
      streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }, { codec_type: "audio", codec_name: "aac" }],
    });
    expect(parseProbe(json)).toEqual({ durationS: 93.46, width: 1280, height: 720, videoCodec: "h264", hasAudio: true });
  });
  it("refuses a file with no video", () => {
    expect(() => parseProbe(JSON.stringify({ format: { duration: "3" }, streams: [{ codec_type: "audio" }] }))).toThrow();
  });
  it("takes the poster past the opening, inside short clips", () => {
    expect(posterAt(600)).toBe(8);
    expect(posterAt(30)).toBe(3);
    expect(posterAt(0.4)).toBe(0);
  });
});

describe("xvEvidenceOf", () => {
  it("keys the stills under the clip's cache folder", () => {
    const ev = xvEvidenceOf("c1", {
      mediaVersion: "xvm-1/large-v3", language: "hi", tookS: 5.8, durationS: 196, hasAudio: true, transcript: [{ at: 0, end: 2, text: "नमस्कार" }],
      cutTimes: [9.4], frames: [{ at: 0, file: "f_0001.jpg" }], contactSheet: "sheet.jpg",
    });
    expect(ev.frames).toEqual([{ at: 0, key: "frames/c1/f_0001.jpg" }]);
    expect(ev.contactSheetKey).toBe("frames/c1/sheet.jpg");
    expect(ev).not.toHaveProperty("durationS");
  });
});

describe("parseReadAnswer", () => {
  const good = { mediaVersion: "xvm-2/large-v3", language: "hi", tookS: 5, durationS: 90, hasAudio: true, transcript: [{ at: 0, end: 1, text: "हां" }], cutTimes: [1.5], frames: [{ at: 0, file: "f_0001.jpg" }], contactSheet: null };
  it("takes a good answer", () => {
    expect(parseReadAnswer(good).frames).toHaveLength(1);
  });
  it("refuses an empty body, a missing list and a still name with a path in it", () => {
    expect(() => parseReadAnswer({})).toThrow(/wrong shape/);
    expect(() => parseReadAnswer({ ...good, transcript: undefined })).toThrow(/wrong shape/);
    expect(() => parseReadAnswer({ ...good, frames: [{ at: 0, file: "../../x.jpg" }] })).toThrow(/wrong shape/);
  });
});

describe("toolError", () => {
  const root = String.raw`\\srv\share`;
  it("tells a missing tool from a missing file, and hides the share's address", () => {
    expect(toolError(Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT", syscall: "spawn ffprobe" }), "ffprobe", root)).toBe("ffprobe is not installed or not on PATH");
    expect(toolError({ stderr: String.raw`\\srv\share\x.mp4: Invalid data found` }, "ffprobe", root)).toBe(String.raw`<share>\x.mp4: Invalid data found`);
  });
});
