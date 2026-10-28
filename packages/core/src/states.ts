// Draft and publish-job state machines. The API and the workers check every change against these,
// and every change is written to audit_log.

export const DRAFT_STATUSES = [
  "rendering", // composed, card PNG not rendered yet
  "render_failed",
  "ready", // in the queue
  "claimed", // an operator holds the lease
  "queued", // approved; publish job waiting out the 10 s undo
  "publishing",
  "published",
  "failed", // publish attempts used up
  "rejected",
  "recalled", // deleted from X after going out
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export type DraftAction =
  | "rendered" | "render_failed" | "rerender"
  | "claim" | "release"
  | "approve" | "undo"
  | "start_publish" | "published" | "retry_later" | "give_up" | "retry"
  | "reject" | "restore" | "recall"
  /** The operator posted by hand on X and records the permalink */
  | "mark_posted";

const DRAFT_MOVES: Record<DraftAction, [DraftStatus[], DraftStatus]> = {
  rendered: [["rendering"], "ready"],
  render_failed: [["rendering"], "render_failed"],
  rerender: [["render_failed"], "rendering"],
  claim: [["ready", "claimed"], "claimed"],
  release: [["claimed"], "ready"],
  approve: [["claimed"], "queued"],
  undo: [["queued"], "claimed"],
  start_publish: [["queued"], "publishing"],
  published: [["publishing"], "published"],
  retry_later: [["publishing"], "queued"],
  give_up: [["publishing"], "failed"],
  retry: [["failed"], "queued"],
  reject: [["claimed"], "rejected"],
  restore: [["rejected"], "ready"],
  recall: [["published"], "recalled"],
  mark_posted: [["claimed"], "published"],
};

/** The status after the action, or null when the action is not allowed from here. */
export function nextDraftStatus(from: DraftStatus, action: DraftAction): DraftStatus | null {
  const [allowed, to] = DRAFT_MOVES[action];
  return allowed.includes(from) ? to : null;
}

export function draftActionsFrom(status: DraftStatus): DraftAction[] {
  return (Object.keys(DRAFT_MOVES) as DraftAction[]).filter((a) => DRAFT_MOVES[a][0].includes(status));
}

export const JOB_STATUSES = ["pending", "running", "succeeded", "cancelled", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const REJECT_REASONS = ["inaccurate", "duplicate", "low_quality", "policy", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
