// What the ingest worker last did, for the dashboard's source-health panel. One kv row, written by
// the ingest loop after every poll; the API reads it. Only failures and polls that took something in
// send a live event, so a quiet source does not chatter.

import type { Db } from "./client";
import { notify } from "./events";
import { getKv, setKv } from "./kv";

export const INGEST_STATUS_KEY = "ingest.status";
const MAX_RECENT_ERRORS = 20;

export type SourceMode = "samvadia" | "folder" | "ftp";

export interface IngestError {
  at: string;
  /** Plain words, no server paths (shown to every desk user) */
  message: string;
  storyId?: string;
  /** errno or similar (EIO, ETIMEDOUT): admins only */
  code?: string;
}

/** The breaking-files share (SOURCE_LAYOUT=breaking): is it there, which day folder is being read */
export interface SourceHealth {
  kind: "breaking";
  reachable: boolean;
  /** "30_OCTOBER_2026": the folder today's files should be in (India time) */
  expectedFolder: string;
  /** As found on the share ("OCTOBER_2026/30_OCTOBER_2026"); null while it is not created yet */
  todayFolder: string | null;
  /** Yesterday's folder, also read all day (late files land there); null when it does not exist */
  alsoScanning: string | null;
  filesToday: number;
  lastFileAt: string | null;
  lastFileName: string | null;
  checkedAt: string;
  lastError: IngestError | null;
}

export interface IngestStatus {
  mode: SourceMode;
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: IngestError | null;
  /** Samvadia only: the newest story taken so far */
  cursor: { publishedAt: string; storyId: string } | null;
  recentErrors: IngestError[];
  /** Breaking-files share only; absent for the other sources */
  source?: SourceHealth | null;
}

export async function readIngestStatus(db: Db): Promise<IngestStatus | null> {
  return getKv<IngestStatus>(db, INGEST_STATUS_KEY);
}

export interface PollResult {
  mode: SourceMode;
  /** Things taken in this poll (stories or media files) */
  taken: number;
  /** The poll as a whole failed */
  error?: string;
  /** Per-item problems that did not stop the poll */
  itemErrors?: IngestError[];
  cursor?: IngestStatus["cursor"];
  /** The share's health after this poll (breaking files) */
  source?: SourceHealth | null;
  /** The same poll error as last time is not added to recentErrors again nor announced (a share down for hours) */
  quietRepeats?: boolean;
}

export async function recordIngestPoll(db: Db, orgId: string, result: PollResult, now = new Date()): Promise<IngestStatus> {
  const at = now.toISOString();
  const prev = await readIngestStatus(db);
  const repeat = !!result.quietRepeats && !!result.error && prev?.lastError?.message === result.error;
  const errors = [...(result.itemErrors ?? []), ...(result.error && !repeat ? [{ at, message: result.error }] : [])];
  const next: IngestStatus = {
    mode: result.mode,
    lastPollAt: at,
    lastOkAt: result.error ? (prev?.lastOkAt ?? null) : at,
    lastError: result.error ? (repeat ? prev!.lastError : { at, message: result.error }) : (result.itemErrors?.[0] ?? null),
    cursor: result.cursor !== undefined ? result.cursor : (prev?.mode === result.mode ? prev.cursor : null),
    recentErrors: [...errors, ...(prev?.recentErrors ?? [])].slice(0, MAX_RECENT_ERRORS),
    ...(result.source !== undefined && { source: result.source }),
  };
  await setKv(db, INGEST_STATUS_KEY, next);
  if (errors.length || result.taken > 0) await notify(db, orgId, { type: "ingest.status", ok: !result.error, at });
  return next;
}

// ─── Phase 1 data files and the API's phase ─────────────────────────────────

export const DATA_STATUS_KEY = "phase1.data_files";

/** Whether the worker could read its places / handles / subjects / reporters / parties files (written when that changes) */
export interface DataFileStatus {
  file: "places" | "handles" | "subjects" | "reporters" | "parties" | "normalise" | "campaigns";
  ok: boolean;
  at: string;
  /** Why not, in plain words (no path) */
  message?: string;
  /** Entries skipped as malformed in the last good read */
  skipped?: number;
}

export async function readDataFileStatus(db: Db): Promise<DataFileStatus[]> {
  return (await getKv<DataFileStatus[]>(db, DATA_STATUS_KEY)) ?? [];
}

export async function recordDataFileStatus(db: Db, status: DataFileStatus): Promise<void> {
  const rest = (await readDataFileStatus(db)).filter((s) => s.file !== status.file);
  await setKv(db, DATA_STATUS_KEY, [...rest, status]);
}

/** The API writes its PHASE here at start; the worker compares before starting anything that posts */
export const API_PHASE_KEY = "api.phase";

export async function recordApiPhase(db: Db, phase: 1 | 2): Promise<void> {
  await setKv(db, API_PHASE_KEY, { phase, at: new Date().toISOString() });
}

export async function readApiPhase(db: Db): Promise<{ phase: 1 | 2; at: string } | null> {
  return getKv(db, API_PHASE_KEY);
}

// ─── Is the ingest worker alive ─────────────────────────────────────────────

/** Written by the ingest worker every WORKER_HEARTBEAT_MS, so a long scan is not mistaken for a stopped worker */
export const WORKER_HEARTBEAT_KEY = "ingest.heartbeat";
export const WORKER_HEARTBEAT_MS = 30_000;
/** No poll and no heartbeat for this long: the worker is stopped (three missed heartbeats) */
export const WORKER_STALE_AFTER_MS = 90_000;
/**
 * The heartbeat proves the process is alive, not that the ingest loop is: a poll stuck on a hung share read
 * keeps beating. A poll that has not finished for this long is stopped, heartbeat or not (the longest normal
 * scan or footage copy takes a few minutes).
 */
export const WORKER_POLL_STALE_AFTER_MS = 15 * 60_000;

export interface WorkerHeartbeat {
  at: string;
  pid: number;
}

export async function recordWorkerHeartbeat(db: Db, now = new Date()): Promise<void> {
  await setKv(db, WORKER_HEARTBEAT_KEY, { at: now.toISOString(), pid: process.pid } satisfies WorkerHeartbeat);
}

export async function readWorkerHeartbeat(db: Db): Promise<WorkerHeartbeat | null> {
  return getKv<WorkerHeartbeat>(db, WORKER_HEARTBEAT_KEY);
}

export interface WorkerLiveness {
  /** The newest of the last poll and the last heartbeat; null when the worker never ran */
  lastSeenAt: string | null;
  /** Seen before, but not within WORKER_STALE_AFTER_MS, or no finished poll within WORKER_POLL_STALE_AFTER_MS */
  stopped: boolean;
}

export function workerLiveness(status: IngestStatus | null, heartbeat: WorkerHeartbeat | null, now = new Date()): WorkerLiveness {
  const at = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
  const poll = at(status?.lastPollAt);
  const seen = [poll, at(heartbeat?.at)].filter((t) => Number.isFinite(t));
  if (!seen.length) return { lastSeenAt: null, stopped: false };
  const last = Math.max(...seen);
  const silent = now.getTime() - last > WORKER_STALE_AFTER_MS;
  const pollStuck = Number.isFinite(poll) && now.getTime() - poll > WORKER_POLL_STALE_AFTER_MS;
  return { lastSeenAt: new Date(last).toISOString(), stopped: silent || pollStuck };
}
