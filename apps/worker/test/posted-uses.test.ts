import { describe, expect, it } from "vitest";
import type { Db } from "@socia/db";
import { Dictionaries } from "../src/stages/compose";

type Row = { handle: string };
const postedUses = (d: Dictionaries, rows: Row[]) =>
  (d as unknown as { postedUses(rows: Row[]): Promise<Map<string, number>> }).postedUses(rows);

describe("Settings handles: posted count", () => {
  it("a failed read does not fail the draft: no counts, every Settings row stays suggest-only", async () => {
    let calls = 0;
    const db = { execute: async () => { calls++; throw new Error("connection reset"); } } as unknown as Db;
    const warnings: unknown[] = [];
    const log = { warn: (...a: unknown[]) => warnings.push(a) } as never;
    const d = new Dictionaries(db, "org", log);
    await expect(postedUses(d, [{ handle: "@JaipurMetro" }])).resolves.toEqual(new Map());
    expect(warnings).toHaveLength(1);
    // Not retried on every story
    await postedUses(d, [{ handle: "@JaipurMetro" }]);
    expect(calls).toBe(1);
  });

  it("a failed read after a good one keeps the last counts", async () => {
    let fail = false;
    const db = {
      execute: async () => {
        if (fail) throw new Error("connection reset");
        return { rows: [{ handle: "jaipurmetro", n: 2 }] };
      },
    } as unknown as Db;
    const d = new Dictionaries(db, "org");
    expect((await postedUses(d, [{ handle: "JaipurMetro" }])).get("jaipurmetro")).toBe(2);
    fail = true;
    // The 5-minute cache runs out, the next read fails: the last counts stand
    (d as unknown as { posted: { at: number } }).posted.at = 0;
    expect((await postedUses(d, [{ handle: "JaipurMetro" }])).get("jaipurmetro")).toBe(2);
    // A different row set has no last counts: none
    await expect(postedUses(d, [{ handle: "JaipurMetro" }, { handle: "Other" }])).resolves.toEqual(new Map());
  });
});
