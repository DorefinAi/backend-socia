// Every role is a loop: do one unit of work, and when there was nothing to do, wait. On SIGTERM
// (every Render deploy) a loop stops taking new work and finishes the unit in flight.

import type { Logger } from "pino";

export interface LoopOptions {
  name: string;
  /**
   * Returns true when it did something, so the loop goes again straight away; false to wait idleMs; a number
   * to wait that many ms instead (e.g. a shorter wait while files settle)
   */
  tick: () => Promise<boolean | number>;
  idleMs: number;
  log: Logger;
  /** While idle, asked every `everyMs`; true ends the wait early (e.g. the desk asked for a scan) */
  wake?: { everyMs: number; check: () => Promise<boolean> };
}

export class Loops {
  private running = true;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly sleepers = new Set<() => void>();

  get active(): boolean {
    return this.running;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  /** Waits ms, in slices of wake.everyMs when given, ending early when wake.check() says so or on stop */
  private async idle(ms: number, wake?: LoopOptions["wake"]): Promise<void> {
    if (!wake) return this.sleep(ms);
    const until = Date.now() + ms;
    while (this.running) {
      const left = until - Date.now();
      if (left <= 0) return;
      await this.sleep(Math.min(wake.everyMs, left));
      if (!this.running || (await wake.check())) return;
    }
  }

  start({ name, tick, idleMs, log, wake }: LoopOptions): void {
    const run = async () => {
      log.info({ loop: name }, "loop started");
      let failures = 0;
      while (this.running) {
        const unit = tick();
        this.inflight.add(unit);
        try {
          const busy = await unit;
          failures = 0;
          if (busy !== true) await this.idle(typeof busy === "number" ? busy : idleMs, wake);
        } catch (err) {
          failures += 1;
          log.error({ loop: name, err }, "loop tick failed");
          await this.sleep(Math.min(idleMs * 2 ** failures, 60_000));
        } finally {
          this.inflight.delete(unit);
        }
      }
      log.info({ loop: name }, "loop stopped");
    };
    void run();
  }

  /** Stop taking work and wait for what is in flight. */
  async stop(): Promise<void> {
    this.running = false;
    for (const wake of this.sleepers) wake();
    await Promise.allSettled([...this.inflight]);
  }
}
