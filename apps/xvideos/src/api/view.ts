// A clip row (+ what the media service read) → the shape the X Videos desk uses (frontend src/data/xVideosData.ts,
// XvClip). Field names match the frontend's so its demo data swaps for these answers with no screen changes.
// The suggested headline is the file's name when the name is a heading, else the model's headline from the screen
// read (step 4).
// Place, tags and mentions are the directory's work (step 5): empty until then.

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
  /** The folders inside the day folder, joined: "Convert 3 pm to----------- / New folder", "" for a file loose in the day */
  innerFolder: string;
  /** The day folder's date, "2026-11-24" */
  day: string | null;
  /** The desk x-marked the file for X */
  picked: boolean;
  /** The desk marked it done (posted) */
  done: boolean;
  /**
   * Where suggestedHeadline came from: the file's name; the screen read (the model's headline from the clip's bar lines
   * and screen text); null: nothing yet (the screen read is still to come, or found nothing)
   */
  headlineSource: "file_name" | "screen" | null;
  /** The file has left the share: its row is kept, its video cannot play */
  gone: boolean;
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

export function xvWireClip(clip: XvClipRow, evidence: XvEvidence | null, withTranscript: boolean, screenHeadline: string | null = null): XvWireClip {
  const reading = clip.status === "reading" || clip.status === "seen";
  // The file's own heading wins: the desk wrote it
  const suggested = clip.heading ?? screenHeadline;
  return {
    id: clip.id,
    fileName: clip.fileName,
    shareName: clip.fileName,
    title: clip.title,
    src: api(clip.id, "video"),
    poster: clip.posterKey ? api(clip.id, "poster") : undefined,
    folder: clip.folder.slice(2),
    innerFolder: clip.folder.slice(3).join(" / "),
    day: clip.day,
    picked: clip.picked,
    done: clip.done,
    headlineSource: clip.heading ? "file_name" : screenHeadline ? "screen" : null,
    gone: clip.status === "gone",
    receivedAt: clip.mtime.toISOString(),
    duration: clip.durationS ?? 0,
    size: clip.size,
    width: clip.width ?? undefined,
    height: clip.height ?? undefined,
    kind: "clip",
    district: "",
    suggestedHeadline: suggested,
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
