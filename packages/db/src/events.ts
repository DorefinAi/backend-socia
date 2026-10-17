// Live updates. A state change sends pg_notify inside its own transaction, so an event goes out only
// if the change commits. Every API instance LISTENs and pushes to its own Socket.IO clients, so no
// separate fan-out service is needed. Events carry ids, never full records: the browser refetches.

import { sql } from "drizzle-orm";
import type { Executor } from "./client";

export const EVENTS_CHANNEL = "socia_events";

export type SociaEvent =
  | { type: "story.arrived"; storyId: string; draftIds: string[] }
  | { type: "draft.updated"; draftId: string; status: string; version: number }
  | { type: "draft.claimed"; draftId: string; userId: string; name: string; until: string }
  | { type: "draft.released"; draftId: string }
  | { type: "post.queued"; draftId: string; jobId: string; sendAt: string }
  | { type: "post.cancelled"; draftId: string; jobId: string }
  | { type: "post.sent"; draftId: string; postId: string; permalink: string }
  | { type: "post.failed"; draftId: string; jobId: string; error: string; final: boolean }
  | { type: "post.recalled"; draftId: string; postId: string }
  | { type: "cap.changed"; platform: string; used: number; cap: number };

export type SociaEventEnvelope = SociaEvent & { orgId: string; platform?: string };

export async function notify(db: Executor, orgId: string, event: SociaEvent, platform = "x"): Promise<void> {
  const payload: SociaEventEnvelope = { ...event, orgId, platform };
  await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(payload)})`);
}
