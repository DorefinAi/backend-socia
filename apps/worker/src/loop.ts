// Every role is a loop: do one unit of work, and when there was nothing to do, wait. On SIGTERM
// (every Render deploy) a loop stops taking new work and finishes the unit in flight.

import type { Logger } from "pino";

export interface LoopOptions {
  name: string;
  /** Returns true when it did something, so the loop goes again straight away */
  tick: () => Promise<boolean>;
  idleMs: number;
  log: Logger;
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

  start({ name, tick, idleMs, log }: LoopOptions): void {
    const run = async () => {
      log.info({ loop: name }, "loop started");
      let failures = 0;
      while (this.running) {
        const unit = tick();
        this.inflight.add(unit);
        try {
          const busy = await unit;
          failures = 0;
          if (!busy) await this.sleep(idleMs);
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
