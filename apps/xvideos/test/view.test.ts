import type { XvClipRow, XvEvidence } from "../src/db/schema";
import { describe, expect, it } from "vitest";
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
