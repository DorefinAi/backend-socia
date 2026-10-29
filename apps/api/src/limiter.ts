// Per-user sliding-window limits for the few calls that cost something (an upload, a live web
// search). In-process, per API instance: enough to stop one session hammering, not a global quota.

export class SlidingLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(readonly limit: number, readonly windowMs: number) {}

  /** True and counted when under the limit; false (and not counted) when over it */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.seen.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.seen.set(key, recent);
      return false;
    }
    recent.push(now);
    this.seen.set(key, recent);
    return true;
  }
}
