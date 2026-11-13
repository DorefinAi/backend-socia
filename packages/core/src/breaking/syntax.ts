// The small patterns several data-file parsers share, defined once so they cannot drift apart.

/** An X handle as the data files write it: an optional @ and 1–15 word characters */
export const HANDLE = /^@?\w{1,15}$/;

/**
 * A letter, mark, digit, zero-width non-joiner or zero-width joiner: what may NOT touch a whole word on either side.
 * ZWNJ/ZWJ are inside Devanagari words ("मुख्य‍मंत्री" with a ZWJ is one word), so they count as part of it.
 */
// String.raw: in a plain string "\p" is just "p", which made this a class of the characters p { L } M N, so
// letters did not count (a Hindi keyword matched inside a longer word) and a "p" beside an English keyword blocked it
export const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}\u200c\u200d]`;

/** `alt` (an alternation, already escaped) as a whole word in Hindi or English */
export const wholeWord = (alt: string, flags = "u"): RegExp => new RegExp(`(?<!${WORD_CHAR})(?:${alt})(?!${WORD_CHAR})`, flags);

/** Text with ZWNJ / ZWJ removed and NFC-normalised: "मुख्य‍मंत्री" reads as "मुख्यमंत्री" */
export const plainText = (text: string): string => text.normalize("NFC").replace(/[‌‍]/g, "");
