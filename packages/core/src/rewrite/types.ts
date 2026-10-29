// The rewriting seam for drafts made from the Web Scraper: rules now, a local model later, one interface.

export type RewriteLang = "hi" | "en" | "mixed";

export interface RewriteInput {
  /** The lead item's headline */
  headline: string;
  /**
   * What each publisher wrote, the lead item's own source first (its summary; may be ""). A text may have
   * several lines: each line is read as its own sentence(s).
   */
  summaries: { source: string; text: string }[];
  /** English district name ("Sawai Madhopur") when the item has one; line 1 of the post already shows it */
  district?: string | null;
  lang: RewriteLang;
}

export interface RewriteOutput {
  headline: string;
  body: string;
  /** Publishers whose text went into the result (the lead source always, when there is one) */
  usedSources: string[];
}

export interface Rewriter {
  /** The REWRITE_MODE it implements; stored on the draft as rewrite.mode */
  name: RewriteMode;
  /** Same input and seed, same output; another seed, other wording */
  rewrite(input: RewriteInput, seed: string): Promise<RewriteOutput>;
}

/**
 * REWRITE_MODE values. Only "rules" exists. A local model ("local-llm") will plug in here: a Rewriter
 * that calls it, chosen in createRewriter, checked by the same similarity gate.
 */
export const REWRITE_MODES = ["rules"] as const;
export type RewriteMode = (typeof REWRITE_MODES)[number];

/** REWRITE_MODE from the environment; unset or "" is "rules", anything unknown stops startup */
export function rewriteModeFrom(value: string | undefined): RewriteMode {
  const v = (value ?? "").trim() || "rules";
  if ((REWRITE_MODES as readonly string[]).includes(v)) return v as RewriteMode;
  throw new Error(`REWRITE_MODE="${v}" is not available. Use one of: ${REWRITE_MODES.join(", ")} (a local model mode is planned, not built).`);
}
