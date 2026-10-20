// Regression tests for the gaps found in the 20 Oct 2026 review, all fixed since. Each note says what
// used to go wrong; a failure here is a bug in src/, not in the test.

import { describe, expect, it } from "vitest";
import { XApiClient } from "../src/x";

describe("known gaps: X client", () => {
  // Was: XApiClient calls fetch with no timeout. A hung connection to X holds the publish loop
  // (one loop per worker) until Node gives up, about 5 minutes, and every queued post waits.
  it("puts a timeout on every call to X", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fake = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify({ data: { id: "1" } }), { status: 200 });
    }) as typeof fetch;
    const x = new XApiClient({ auth: { header: async () => "Bearer t" }, username: "a", fetch: fake });
    await x.createPost("hello", []);
    await x.getPost("1");
    expect(seen.length).toBe(2);
    for (const signal of seen) expect(signal, "fetch was called without an AbortSignal").toBeInstanceOf(AbortSignal);
  });
});
