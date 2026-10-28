import { describe, expect, it } from "vitest";
import {
  backoffSeconds, capLevel, draftActionsFrom, istDayStart, largestFitting, nextDraftStatus,
  parseStory, slugParts, totpCode, verifyTotp,
} from "../src";

describe("parseStory", () => {
  it("takes line 1 as the headline", () => {
    expect(parseStory("जयपुर में बारिश\r\nपूरे शहर में पानी भरा।\r\n\r\n\r\nस्कूल बंद।")).toEqual({
      headline: "जयपुर में बारिश",
      body: "पूरे शहर में पानी भरा।\n\nस्कूल बंद।",
      parseMethod: "line1",
      parseNote: null,
    });
  });

  it("flags a file with no line break", () => {
    expect(parseStory("एक ही पंक्ति").parseMethod).toBe("needs_review");
  });

  it("flags an over-long first line", () => {
    expect(parseStory(`${"क".repeat(201)}\nbody`).parseNote).toContain("201 characters");
  });

  it("flags an empty file", () => {
    expect(parseStory(" \n \n").parseMethod).toBe("needs_review");
  });
});

describe("slugParts", () => {
  it("normalises case, spaces and dashes", () => {
    expect(slugParts("JPR_Metro-Phase2.txt")).toEqual({ slug: "jpr_metro_phase2", seq: null, ext: "txt", kind: "text" });
    expect(slugParts("D:\\share\\JPR METRO  PHASE2.mp4").slug).toBe("jpr_metro_phase2");
  });

  it("splits off a trailing sequence number", () => {
    expect(slugParts("jpr_metro_phase2_01.jpg")).toMatchObject({ slug: "jpr_metro_phase2", seq: 1, kind: "image" });
    expect(slugParts("JPR_METRO_PHASE2_2.MOV")).toMatchObject({ slug: "jpr_metro_phase2", seq: 2, kind: "video" });
  });

  it("keeps a date prefix and a 4-digit tail", () => {
    expect(slugParts("171026_UDR_FLOOD_2026.txt")).toMatchObject({ slug: "171026_udr_flood_2026", seq: null });
  });
});

describe("draft states", () => {
  it("allows the operator path", () => {
    expect(nextDraftStatus("ready", "claim")).toBe("claimed");
    expect(nextDraftStatus("claimed", "approve")).toBe("queued");
    expect(nextDraftStatus("queued", "undo")).toBe("claimed");
    expect(nextDraftStatus("published", "recall")).toBe("recalled");
  });

  it("refuses skipping the queue", () => {
    expect(nextDraftStatus("ready", "approve")).toBeNull();
    expect(nextDraftStatus("publishing", "undo")).toBeNull();
  });

  it("lists what a claimed draft can do", () => {
    expect(draftActionsFrom("claimed").sort()).toEqual(["approve", "claim", "mark_posted", "reject", "release"]);
  });
});

describe("time rules", () => {
  it("starts the cap day at midnight IST", () => {
    // 17 Oct 2026, 02:00 IST = 16 Oct 20:30 UTC → day began 16 Oct 18:30 UTC
    expect(istDayStart(new Date("2026-10-16T20:30:00Z")).toISOString()).toBe("2026-10-16T18:30:00.000Z");
    expect(istDayStart(new Date("2026-10-16T18:29:00Z")).toISOString()).toBe("2026-10-15T18:30:00.000Z");
  });

  it("backs off and caps at 10 minutes", () => {
    expect([1, 2, 3, 10].map(backoffSeconds)).toEqual([15, 30, 60, 600]);
  });

  it("colours the cap meter at 80% and 95%", () => {
    expect([100, 640, 760, 800].map((used) => capLevel(used, 800))).toEqual(["ok", "warn", "danger", "full"]);
  });
});

describe("largestFitting", () => {
  it("finds the largest size that fits", () => {
    expect(largestFitting((px) => px <= 61, 28, 96)).toBe(61);
    expect(largestFitting(() => false, 28, 96)).toBe(28);
  });
});

describe("TOTP", () => {
  // RFC 6238 test vector: secret "12345678901234567890", T = 59 s → 94287082 (8 digits)
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches the RFC vector", () => {
    expect(totpCode(secret, new Date(59_000), 30, 8)).toBe("94287082");
  });

  it("accepts one step of drift and rejects older codes", () => {
    const now = new Date("2026-10-17T10:00:00Z");
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 30_000)), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 90_000)), now)).toBe(false);
  });
});
