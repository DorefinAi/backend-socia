// PHASE: one switch for the whole backend. 1 = breaking files → Copy & Posted; the X API, Samvadia, footage
// and non-X platforms are off (their code stays). Unset or 2 = everything, as before phase 1 existed.

export type Phase = 1 | 2;

/** An unknown value stops startup rather than running the wrong product */
export function phaseFrom(value: string | undefined): Phase {
  const v = (value ?? "").trim();
  if (v === "" || v === "2") return 2;
  if (v === "1") return 1;
  throw new Error(`PHASE must be 1 or 2 (got "${v}")`);
}

/** What the desk shows and the backend allows in a phase (GET /me "features") */
export function phaseFeatures(phase: Phase) {
  const full = phase === 2;
  return {
    xApiPosting: full,
    copyPosted: true,
    cardOnDemand: !full,
    samvadia: full,
    webScraper: true,
    platforms: ["x"],
  };
}

export const PHASE_OFF_MESSAGE = "Posting through the X API is off in phase 1. Use Copy & Posted.";
