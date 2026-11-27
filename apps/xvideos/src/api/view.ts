// A clip row (+ what the media service read) → the shape the X Videos desk uses (frontend src/data/xVideosData.ts,
// XvClip). Field names match the frontend's so its demo data swaps for these answers with no screen changes.
// The suggested headline is the file's name when the name is a heading, else the model's headline from the screen
// read (step 4). Place, channel label, tags and mentions are composed around it from the directory (step 5,
// src/compose): on = in the post as drafted, off = offered.

import type { XvComposeInput, XvComposed } from "../compose/compose";
import type { XvListedClip } from "../db/clips";
import type { XvClipRow, XvDeskDraft, XvEvidence, XvHeadlineResult } from "../db/schema";

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
  /** The Rajasthan district the post is about ("Jaipur"), "" when none */
  district: string;
  /** Rajasthan or outside it: sets the brand tag on the desk */
  region?: "rajasthan" | "india";
  suggestedHeadline: string | null;
  /** 0–100 while being read; absent once read */
  readingProgress?: number;
  transcript: { at: number; text: string }[];
  screenText: never[];
  frames?: { where: "first" | "mid" | "last"; at: number; src: string; text: string }[];
  contactSheet?: string;
  cutTimes?: number[];
  heard: string[];
  /** The title's ending ("Jaipur News", "Rajasthan News", the file name's own), null with no headline yet */
  channelLabel: string | null;
  /** Without the brand tag and #FINVideo (the desk adds both); `why` says where each came from */
  hashtags: { value: string; on: boolean; why?: string }[];
  mentions: { value: string; on: boolean; why?: string }[];
  /**
   * The desk's decision (step 6): posted (Copy & Mark Posted) or rejected, and not undone; else a file marked done on the
   * share was posted by hand before the desk existed; else new
   */
  status: XvWireStatus;
  postedAt?: string;
  /** The standing post's id: undo names it, so a stale tab cannot take back a newer post */
  postId?: number;
  /** The text copied to X */
  postedText?: string;
  postedBy?: string;
  rejectedReason?: string;
  /** The editor who holds the clip ("on it"), by name */
  heldBy?: string;
  /** The editor's saved draft (the desk opens it instead of the suggestion), and when it was saved */
  draft?: XvDeskDraft;
  draftSavedAt?: string;
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

/** What the composer gets for a clip: its suggested headline and, when the model wrote it, the model's place and topics */
export function xvComposeInput(clip: XvClipRow, screenHeadline: string | null, screenResult: XvHeadlineResult | null): XvComposeInput | null {
  const headline = clip.heading ?? screenHeadline;
  if (!headline) return null;
  // The stored result is checked field by field: an old or partial row must not break the day's list
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const model =
    !clip.heading && screenResult
      ? {
          district: text(screenResult.district),
          state: text(screenResult.state),
          topicHashtags: Array.isArray(screenResult.topicHashtags) ? screenResult.topicHashtags.filter((t): t is string => typeof t === "string") : [],
        }
      : null;
  return { headline, fileTitle: clip.title, day: clip.day, model };
}

export function xvWireClip(row: Pick<XvListedClip, "clip" | "screenHeadline"> & Partial<XvListedClip>, evidence: XvEvidence | null, withTranscript: boolean, composed: XvComposed | null = null): XvWireClip {
  const { clip, screenHeadline } = row;
  const decision = row.decision ?? null;
  const desk = row.desk ?? null;
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
    district: composed?.district ?? "",
    region: composed?.region,
    suggestedHeadline: suggested,
    readingProgress: reading ? (clip.progress ?? 0) : undefined,
    transcript: withTranscript && evidence ? evidence.transcript.map((l) => ({ at: l.at, text: l.text })) : [],
    screenText: [],
    frames: evidence ? frameGrabs(clip.id, evidence.frames) : undefined,
    contactSheet: evidence?.contactSheetKey ? api(clip.id, `frames/${encodeURIComponent(baseName(evidence.contactSheetKey))}`) : undefined,
    cutTimes: evidence?.cutTimes,
    heard: [],
    channelLabel: composed?.channelLabel ?? null,
    hashtags: composed?.hashtags ?? [],
    mentions: composed?.mentions ?? [],
    status: decision ? decision.action : clip.done ? "posted" : "new",
    postedAt: decision?.action === "posted" ? decision.at.toISOString() : undefined,
    postId: decision?.action === "posted" ? decision.id : undefined,
    postedText: decision?.action === "posted" ? (decision.text ?? undefined) : undefined,
    postedBy: decision?.action === "posted" ? (decision.byName ?? undefined) : undefined,
    rejectedReason: decision?.action === "rejected" ? (decision.reason ?? undefined) : undefined,
    heldBy: desk?.heldByName ?? undefined,
    draft: desk?.draft ?? undefined,
    draftSavedAt: desk?.draft ? desk.updatedAt.toISOString() : undefined,
    error: clip.status === "failed" ? (clip.error ?? "could not be read") : undefined,
  };
}
