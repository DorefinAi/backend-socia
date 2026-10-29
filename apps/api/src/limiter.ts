// Sliding-window limits, in-process and per API instance: per-user caps on the few calls that cost
// something (an upload, a live web search) and the sign-in failure limits (routes/auth.ts). Enough to stop
// one client hammering, not a global quota.
//
// Keys can come from clients (an email at sign-in), so the map is bounded: idle keys are pruned on an
// unref'd timer (one window apart), and past `maxKeys` the least recently touched keys are evicted.
// A touched key is re-inserted, so Map order is "least recently touched first".

export class SlidingLimiter {
  private readonly seen = new Map<string, number[]>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly limit: number, readonly windowMs: number, readonly maxKeys = 10_000) {
    this.timer = setInterval(() => this.prune(), Math.max(windowMs, 1000));
    this.timer.unref();
  }

  private recent(key: string, now: number): number[] {
    return (this.seen.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  private store(key: string, times: number[]): void {
    this.seen.delete(key);
    if (!times.length) return;
    this.seen.set(key, times);
    while (this.seen.size > this.maxKeys) this.seen.delete(this.seen.keys().next().value!);
  }

  /** True and counted when under the limit; false (and not counted) when over it */
  take(key: string, now = Date.now()): boolean {
    const recent = this.recent(key, now);
    if (recent.length >= this.limit) return false;
    recent.push(now);
    this.store(key, recent);
    return true;
  }

  /** True when `key` has used up its limit in the window (nothing counted) */
  isOver(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  /** Counts one event (e.g. a failure) against `key` */
  record(key: string, now = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.store(key, recent);
  }

  /** Forgets keys with no event inside the window */
  prune(now = Date.now()): void {
    for (const [key, times] of this.seen) if (!times.some((t) => now - t < this.windowMs)) this.seen.delete(key);
  }

  get size(): number {
    return this.seen.size;
  }

  /** Stops the prune timer (app close) */
  close(): void {
    clearInterval(this.timer);
  }
}
