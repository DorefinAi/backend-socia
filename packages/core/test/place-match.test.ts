// The spelling-tolerant place matcher (b9 B4/B6). The frontend's copy reads the same case list.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openingPlaceLength, placeMatchKey } from "../src";

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/place-match-cases.json", import.meta.url), "utf8")) as {
  cases: { headline: string; names: string[]; length: number }[];
};

describe("openingPlaceLength (shared cases)", () => {
  it.each(cases.map((c) => [c.headline, c.names.join(" | "), c.length, c] as const))("%s / %s → %i", (_h, _n, length, c) => {
    expect(openingPlaceLength(c.headline, c.names)).toBe(length);
  });
});

describe("placeMatchKey", () => {
  it("is the same for nasal, nukta, vowel-length, joiner and spacing variants", () => {
    expect(placeMatchKey("नैनवा")).toBe(placeMatchKey("नैनवां"));
    expect(placeMatchKey("बूँदी")).toBe(placeMatchKey("बूंदी"));
    expect(placeMatchKey("बड़ी सादड़ी")).toBe(placeMatchKey("बड़ीसादड़ी"));
    expect(placeMatchKey("बड़ी‌सादड़ी")).toBe(placeMatchKey("बड़ीसादड़ी"));
    expect(placeMatchKey("Sawai-Madhopur")).toBe(placeMatchKey("sawai madhopur"));
    // Different places stay different
    expect(placeMatchKey("कोटा")).not.toBe(placeMatchKey("कोटड़ा"));
  });
});
