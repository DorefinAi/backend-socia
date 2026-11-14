// The loop's waits: false waits idleMs, a number waits that long, and a wake check ends a wait early.

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { Loops } from "../src/loop";

const log = pino({ level: "silent" });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Loops", () => {
  let loops: Loops;
  afterEach(async () => loops?.stop());

  it("waits the ms a tick returns instead of idleMs", async () => {
    loops = new Loops();
    let ticks = 0;
    loops.start({ name: "t", idleMs: 10_000, log, tick: async () => (ticks++, 30) });
    await pause(200);
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it("waits idleMs when a tick returns false", async () => {
    loops = new Loops();
    let ticks = 0;
    loops.start({ name: "t", idleMs: 10_000, log, tick: async () => (ticks++, false) });
    await pause(150);
    expect(ticks).toBe(1);
  });

  it("ends an idle wait early when the wake check says so", async () => {
    loops = new Loops();
    let ticks = 0;
    let asked = false;
    const check = async () => {
      const was = asked;
      asked = false;
      return was;
    };
    loops.start({ name: "t", idleMs: 10_000, log, wake: { everyMs: 20, check }, tick: async () => (ticks++, false) });
    await pause(60);
    expect(ticks).toBe(1);
    asked = true;
    await pause(80);
    expect(ticks).toBe(2);
    await pause(80);
    expect(ticks).toBe(2);
  });

  it("stop() ends a sliced wait at once", async () => {
    loops = new Loops();
    let checks = 0;
    loops.start({ name: "t", idleMs: 10_000, log, wake: { everyMs: 20, check: async () => (checks++, false) }, tick: async () => false });
    await pause(50);
    const started = Date.now();
    await loops.stop();
    expect(Date.now() - started).toBeLessThan(100);
    const after = checks;
    await pause(60);
    expect(checks).toBe(after);
  });
});
