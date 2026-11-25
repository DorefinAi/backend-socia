import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProbe, posterAt, toolError } from "../src/worker/probe";
import { parseReadAnswer, xvEvidenceOf } from "../src/worker/read";
import { XvShareReader, XvShareUnreachable, type XvShareFs } from "../src/worker/share";

const ROOT = "S:\\share";
const day = { year: "2026", month: "NOVEMBER 2026", day: "24-11-2026" };

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
  const tree = {
    [ROOT]: ["2026/", "logo2/"],
    [p("2026")]: ["November 2026/", "August 2026/"],
    [p("2026", "November 2026")]: ["24-11-2026/"],
    [p("2026", "November 2026", "24-11-2026")]: ["Convert 3 pm/", "loose.png", "x...JO.mp4"],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm")]: ["x...done......Kota News.mp4", "New folder/", "a.mpg.ese2"],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm", "New folder")]: ["deep.mkv"],
  };
  const files = {
    [p("2026", "November 2026", "24-11-2026", "x...JO.mp4")]: [100, 1000] as [number, number],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm", "x...done......Kota News.mp4")]: [200, 2000] as [number, number],
    [p("2026", "November 2026", "24-11-2026", "Convert 3 pm", "New folder", "deep.mkv")]: [300, 3000] as [number, number],
  };

  it("finds the videos of a day, month folder matched without case, shift folders included", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files));
    const out = await r.listDay(day);
    expect(out.dayFolder).toEqual(["2026", "November 2026", "24-11-2026"]);
    expect(out.complete).toBe(true);
    expect(out.files.map((f) => [f.folder.slice(3).join("/"), f.fileName, f.size]).sort((a, b) => Number(a[2]) - Number(b[2]))).toEqual([
      ["", "x...JO.mp4", 100],
      ["Convert 3 pm", "x...done......Kota News.mp4", 200],
      ["Convert 3 pm/New folder", "deep.mkv", 300],
    ]);
  });

  it("says a day the share has no folder for yet is empty and complete", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files));
    expect(await r.listDay({ ...day, day: "25-11-2026" })).toEqual({ dayFolder: null, files: [], complete: true });
  });

  it("marks the listing incomplete when a shift folder cannot be read", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files, [p("2026", "November 2026", "24-11-2026", "Convert 3 pm")]));
    const out = await r.listDay(day);
    expect(out.complete).toBe(false);
    expect(out.files.map((f) => f.fileName)).toEqual(["x...JO.mp4"]);
  });

  it("reports the share as unreachable when the root fails", async () => {
    const r = new XvShareReader(ROOT, fakeFs(tree, files, [ROOT]));
    await expect(r.listDay(day)).rejects.toBeInstanceOf(XvShareUnreachable);
  });

  it("times out a hung share call", async () => {
    const hung: XvShareFs = { readdir: () => new Promise(() => undefined), stat: () => new Promise(() => undefined) };
    await expect(new XvShareReader(ROOT, hung, 20).listDay(day)).rejects.toBeInstanceOf(XvShareUnreachable);
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
