// Every state transition writes here, with actor and before/after. It is what answers "who approved
// this post", and under the IT Rules 2021 it is a compliance record, not overhead.

import type { Executor } from "./client";
import { auditLog } from "./schema";

export interface AuditEntry {
  orgId: string;
  actorId: string | null;
  /** When no user acted (actorId null): "owner:<name>" for the owner console */
  actor?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export async function audit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({ ...entry, before: entry.before ?? null, after: entry.after ?? null });
}
