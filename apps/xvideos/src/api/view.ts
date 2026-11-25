// A clip row (+ what the media service read) → the shape the X Videos desk uses (frontend src/data/xVideosData.ts,
// XvClip). Field names match the frontend's so its demo data swaps for these answers with no screen changes.
// Headline, place, tags and mentions are the headline steps' work: empty until then.

import type { XvClipRow, XvEvidence } from "../db/schema";

export type XvWireStatus = "new" | "posted" | "rejected";

export interface XvWireClip {
  id: string;
  fileName: string;
  /** The share's name, marks included */
  shareName: string;
  /** The name without marks and extension (often the desk's own title) */
  title: string;
  /** API paths; the desk prefixes its API base */
  src: string;
  poster?: string;
  /** Folder parts under the month folder: ["24-11-2026", "Convert 3 pm to-----------"] */
  folder: string[];
  receivedAt: string;
  duration: number;
  size: number;
  width?: number;
  height?: number;
  kind: "clip";
  district: string;
  suggestedHeadline: string | null;
  /** 0–100 while being read; absent once read */
  readingProgress?: number;
  transcript: { at: number; text: string }[];
  screenText: never[];
  frames?: { where: "first" | "mid" | "last"; at: number; src: string; text: string }[];
  contactSheet?: string;
  cutTimes?: number[];
  heard: string[];
  channelLabel: string | null;
  hashtags: { value: string; on: boolean }[];
  mentions: { value: string; on: boolean }[];
  /** done on the share = the desk already posted it on X by hand */
  status: XvWireStatus;
  /** Why the clip could not be read (probe or speech failed after its retries) */
  error?: string;
}

const api = (id: string, tail: string) => `/xvideos/clips/${id}/${tail}`;

/** The first, middle and last stills of the evidence, for the desk's On screen panel */
function frameGrabs(id: string, frames: XvEvidence["frames"]): XvWireClip["frames"] {
  if (!frames.length) return undefined;
  const picks: ["first" | "mid" | "last", number][] = [["first", 0], ["mid", Math.floor(frames.length / 2)], ["last", frames.length - 1]];
  return picks.map(([where, i]) => ({ where, at: frames[i]!.at, src: api(id, `frames/${encodeURIComponent(baseName(frames[i]!.key))}`), text: "" }));
}

const baseName = (key: string) => key.split(/[\\/]/).pop() ?? key;

export function xvWireClip(clip: XvClipRow, evidence: XvEvidence | null, withTranscript: boolean): XvWireClip {
  const reading = clip.status === "reading" || clip.status === "seen";
  return {
    id: clip.id,
    fileName: clip.fileName,
    shareName: clip.fileName,
    title: clip.title,
    src: api(clip.id, "video"),
    poster: clip.posterKey ? api(clip.id, "poster") : undefined,
    folder: clip.folder.slice(2),
    receivedAt: clip.mtime.toISOString(),
    duration: clip.durationS ?? 0,
    size: clip.size,
    width: clip.width ?? undefined,
    height: clip.height ?? undefined,
    kind: "clip",
    district: "",
    suggestedHeadline: null,
    readingProgress: reading ? (clip.progress ?? 0) : undefined,
    transcript: withTranscript && evidence ? evidence.transcript.map((l) => ({ at: l.at, text: l.text })) : [],
    screenText: [],
    frames: evidence ? frameGrabs(clip.id, evidence.frames) : undefined,
    contactSheet: evidence?.contactSheetKey ? api(clip.id, `frames/${encodeURIComponent(baseName(evidence.contactSheetKey))}`) : undefined,
    cutTimes: evidence?.cutTimes,
    heard: [],
    channelLabel: null,
    hashtags: [],
    mentions: [],
    status: clip.done ? "posted" : "new",
    error: clip.status === "failed" ? (clip.error ?? "could not be read") : undefined,
  };
}
