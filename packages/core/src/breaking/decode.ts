// A breaking file's bytes as text. The desk saves UTF-8 from Notepad; Notepad's "Unicode" (UTF-16, with or
// without its byte-order mark) is read too. Anything else is not a file the desk wrote: binary data, a damaged
// file, bytes in no text encoding. Those are rejected (the story fails and stays out of the queue, owner
// 15 Nov 2026), never shown as garbled text. Measured on the share 14-15 Nov 2026: all 866 .txt files UTF-8.

export type BreakingCharset = "utf-8" | "utf-16le" | "utf-16be";
export type DecodedBreaking = { text: string; charset: BreakingCharset } | { unreadable: string };

/** Share of a decoded text's characters that may be junk (U+FFFD, control codes) before the file is rejected */
const MAX_JUNK = 0.01;
const UNREADABLE = "The file can't be read: it is not text the desk saves (UTF-8 or Unicode).";
const BINARY = "The file can't be read: it holds binary data, not text.";

const decode = (label: string, bytes: Uint8Array, fatal: boolean) => new TextDecoder(label, { fatal, ignoreBOM: false }).decode(bytes);

/** UTF-16 without a byte-order mark: a quarter or more of the bytes are zero, nearly all at the odd (LE) or even (BE) places */
function utf16Guess(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (bytes.length < 4 || bytes.length % 2) return null;
  let odd = 0;
  let even = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) i % 2 ? odd++ : even++;
  const half = bytes.length / 2;
  if (odd >= half / 4 && even <= odd / 20) return "utf-16le";
  if (even >= half / 4 && odd <= even / 20) return "utf-16be";
  return null;
}

/** Control codes other than tab, line breaks and form feed; and U+FFFD, a byte that was no character */
const JUNK = /[\u0000-\u0008\u000E-\u001F\u007F�]/g;
/** At least two junk characters are allowed, so one stray byte never rejects a short file (M2) */
const tooMuchJunk = (text: string) => (text.match(JUNK)?.length ?? 0) > Math.max(2, text.length * MAX_JUNK);

/** Characters a breaking file is made of: Devanagari, Latin letters and digits, punctuation, spaces and line breaks */
const PLAIN = /[ऀ-ॿ -~\t\n\r ‌‍‐-‧₹]/g;
const plainShare = (text: string) => (text.length ? (text.match(PLAIN)?.length ?? 0) / text.length : 0);

/**
 * UTF-16 with no byte-order mark and mostly Hindi (few zero bytes, so utf16Guess misses it): read both ways, the
 * one that is almost all plain characters (L1). Its bytes are valid UTF-8 control codes, so this is tried only when
 * the UTF-8 reading came out as junk.
 */
function utf16ByContent(bytes: Uint8Array): { text: string; charset: BreakingCharset } | null {
  if (bytes.length < 4 || bytes.length % 2) return null;
  for (const charset of ["utf-16le", "utf-16be"] as const) {
    const text = decode(charset, bytes, false);
    if (plainShare(text) >= 0.95 && !tooMuchJunk(text)) return { text, charset };
  }
  return null;
}

export function decodeBreakingFile(bytes: Uint8Array): DecodedBreaking {
  const charset: BreakingCharset =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : (utf16Guess(bytes) ?? "utf-8");
  let text: string;
  try {
    // The decoder drops a byte-order mark of its own encoding
    text = decode(charset, bytes, true);
  } catch {
    // A few broken bytes in an otherwise good file keep the story (each shows as U+FFFD); more is not text
    text = decode(charset, bytes, false);
    if (tooMuchJunk(text)) return utf16ByContent(bytes) ?? { unreadable: UNREADABLE };
  }
  // A NUL in UTF-8 text, or control codes all over: Hindi UTF-16 with no mark, else binary data saved as .txt
  if (text.includes("\u0000") || tooMuchJunk(text)) return (charset === "utf-8" && utf16ByContent(bytes)) || { unreadable: BINARY };
  return { text, charset };
}
