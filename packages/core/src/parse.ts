// Control-room file layout (confirmed by the client): line 1 is the headline, the rest is the body.

export type ParseMethod = "line1" | "needs_review";

export interface ParsedStory {
  headline: string;
  body: string;
  parseMethod: ParseMethod;
  /** Why the file needs a human look, when parseMethod is needs_review */
  parseNote: string | null;
}

/** Longer than this, line 1 is not a headline but a paragraph with no line break after it. */
export const MAX_HEADLINE_CHARS = 200;

export function parseStory(text: string): ParsedStory {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const firstIndex = lines.findIndex((l) => l.length > 0);

  if (firstIndex === -1) {
    return { headline: "", body: "", parseMethod: "needs_review", parseNote: "The file is empty." };
  }

  const headline = lines[firstIndex]!;
  const body = lines
    .slice(firstIndex + 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Phase 1 has no LLM fallback: odd files go to the operator flagged instead
  let parseNote: string | null = null;
  if (firstIndex > 0) parseNote = "Line 1 is empty; the first line with text was taken as the headline.";
  if (!body) parseNote = "The file is one line, so there is no separate headline.";
  if (headline.length > MAX_HEADLINE_CHARS) {
    parseNote = `Line 1 is ${headline.length} characters, too long for a headline.`;
  }

  return { headline, body, parseMethod: parseNote ? "needs_review" : "line1", parseNote };
}
