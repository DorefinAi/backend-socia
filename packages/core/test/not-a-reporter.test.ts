// @svoruganti1466 is the Chief Secretary's account, not a reporter (13 Nov 2026).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseReporterHandles,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));

// ─── 4. @svoruganti1466 is not a reporter ────────────────────────────────────

describe("4. @svoruganti1466 is the Chief Secretary's account, not a reporter", () => {
  it("is no reporter entry, and the desk has a to-do to confirm the account", () => {
    const json = cfg("reporter-handles.json");
    expect(json.entries.map((e: { handle: string }) => e.handle.toLowerCase())).not.toContain("@svoruganti1466");
    expect(reporters.handles!.has("svoruganti1466")).toBe(false);
    expect([...reporters.byToken.keys()].map((k) => k.toLowerCase())).not.toContain("voruganti");
    expect(json._todo_for_desk).toContain("confirm @svoruganti1466 is the Chief Secretary's account");
  });
});
