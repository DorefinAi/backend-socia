import type { XvClipRow, XvEvidence } from "../src/db/schema";
import { describe, expect, it } from "vitest";
import { xvGroupDays } from "../src/api/routes";
import { xvWireClip } from "../src/api/view";

const clip = (over: Partial<XvClipRow> = {}): XvClipRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "o",
  folder: ["2026", "NOVEMBER 2026", "24-11-2026", "Convert 3 pm to"],
  fileName: "x...done......Kota News.mp4",
  size: 1000,
  mtime: new Date("2026-11-24T10:00:00Z"),
  fingerprint: "1000:1",
  picked: true,
  done: true,
  title: "Kota News",
  day: "2026-11-24",
  heading: null,
  status: "new",
  progress: null,
  settledAt: new Date(),
  durationS: 93.5,
  width: 1280,
  height: 720,
  videoCodec: "h264",
  hasAudio: true,
  posterKey: "posters/x.jpg",
  error: null,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
  goneAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const evidence: XvEvidence = {
  mediaVersion: "xvm-1/large-v3",
  language: "hi",
  tookS: 5,
  transcript: [{ at: 0, end: 2, text: "नमस्कार" }],
  cutTimes: [9.4],
  frames: [0, 2, 4, 6, 8].map((at, i) => ({ at, key: `frames/c/f_000${i + 1}.jpg` })),
  contactSheetKey: "frames/c/sheet.jpg",
};

describe("xvGroupDays", () => {
  it("groups days by month, newest first, with today in its place even with no videos yet", () => {
    const d = (day: string, clips = 1) => ({ day, clips, picked: 0, done: 0 });
    expect(xvGroupDays("2026-12-01", [d("2026-11-30"), d("2026-11-29")])).toEqual([
      { month: "2026-12", days: [d("2026-12-01", 0)] },
      { month: "2026-11", days: [d("2026-11-30"), d("2026-11-29")] },
    ]);
    // A mistyped future day folder does not split today's month in two
    expect(xvGroupDays("2026-11-27", [d("2026-12-28"), d("2026-11-26")]).map((m) => m.month)).toEqual(["2026-12", "2026-11"]);
  });
});

describe("xvWireClip", () => {
  it("gives the desk's fields: folder under the month, API media paths, done = posted", () => {
    const w = xvWireClip(clip(), null, false);
    expect(w.folder).toEqual(["24-11-2026", "Convert 3 pm to"]);
    expect(w.src).toBe("/xvideos/clips/11111111-1111-4111-8111-111111111111/video");
    expect(w.poster).toBe("/xvideos/clips/11111111-1111-4111-8111-111111111111/poster");
    expect(w.status).toBe("posted");
    expect(w.duration).toBe(93.5);
    expect(w.readingProgress).toBeUndefined();
    expect(w.suggestedHeadline).toBeNull();
    expect(w.headlineSource).toBeNull();
  });

  it("gives the day, the inner folders, the x / done marks, and the heading from the file name", () => {
    const w = xvWireClip(
      clip({ folder: ["2026", "NOVEMBER 2026", "24-11-2026", "Convert 3 pm to", "New folder"], picked: false, done: false, heading: "हत्या का खुलासा, दो गिरफ्तार | Kota News" }),
      null,
      false,
    );
    expect(w).toMatchObject({ day: "2026-11-24", innerFolder: "Convert 3 pm to / New folder", picked: false, done: false, gone: false });
    expect(w.suggestedHeadline).toBe("हत्या का खुलासा, दो गिरफ्तार | Kota News");
    expect(w.headlineSource).toBe("file_name");
    expect(xvWireClip(clip({ folder: ["2026", "NOVEMBER 2026", "24-11-2026"], status: "gone" }), null, false)).toMatchObject({ innerFolder: "", gone: true });
  });

  it("shows progress while reading and the reason when failed", () => {
    expect(xvWireClip(clip({ status: "reading", progress: 20, done: false }), null, false)).toMatchObject({ readingProgress: 20, status: "new" });
    expect(xvWireClip(clip({ status: "failed", error: "probe: no video" }), null, false).error).toBe("probe: no video");
  });

  it("adds the transcript only when asked, and the first, middle and last stills", () => {
    expect(xvWireClip(clip(), evidence, false).transcript).toEqual([]);
    const w = xvWireClip(clip(), evidence, true);
    expect(w.transcript).toEqual([{ at: 0, text: "नमस्कार" }]);
    expect(w.frames?.map((f) => [f.where, f.at])).toEqual([["first", 0], ["mid", 4], ["last", 8]]);
    expect(w.frames?.[0]?.src).toMatch(/\/frames\/f_0001\.jpg$/);
    expect(w.contactSheet).toMatch(/\/frames\/sheet\.jpg$/);
  });
});
