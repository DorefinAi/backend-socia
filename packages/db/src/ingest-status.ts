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
  message: string;
  storyId?: string;
}

export interface IngestStatus {
  mode: SourceMode;
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: IngestError | null;
  /** Samvadia only: the newest story taken so far */
  cursor: { publishedAt: string; storyId: string } | null;
  recentErrors: IngestError[];
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
}

export async function recordIngestPoll(db: Db, orgId: string, result: PollResult, now = new Date()): Promise<IngestStatus> {
  const at = now.toISOString();
  const prev = await readIngestStatus(db);
  const errors = [...(result.itemErrors ?? []), ...(result.error ? [{ at, message: result.error }] : [])];
  const next: IngestStatus = {
    mode: result.mode,
    lastPollAt: at,
    lastOkAt: result.error ? (prev?.lastOkAt ?? null) : at,
    lastError: result.error ? { at, message: result.error } : (result.itemErrors?.[0] ?? null),
    cursor: result.cursor !== undefined ? result.cursor : (prev?.mode === result.mode ? prev.cursor : null),
    recentErrors: [...errors, ...(prev?.recentErrors ?? [])].slice(0, MAX_RECENT_ERRORS),
  };
  await setKv(db, INGEST_STATUS_KEY, next);
  if (errors.length || result.taken > 0) await notify(db, orgId, { type: "ingest.status", ok: !result.error, at });
  return next;
}
