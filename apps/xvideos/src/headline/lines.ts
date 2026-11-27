// Step 4: which of a clip's headline bar lines go to the model (README §4.2). Pure.
//
// A programme bar ("गांव की पंचायत", election days) rotates the same few general lines on every clip it runs over, with
// the programme's name glued to the front of each line ("गांव की 37 जिलों की 419 पंचायत समितियों में प्रधान का चुनाव").
// The clip's own story is then only in the right panel. Two fixes, from the day's other screen reads:
//   A. A bar line seen on XV_FILLER_MIN_CLIPS+ of the day's clips is programme filler, and dropped, when it starts with
//      the programme's name.
//   C. The programme's name is cut from the front of the clip's other bar lines.
// The programme's name is found, not listed: the 2 leading words that XV_PREFIX_MIN_LINES+ different repeated lines
// start with ("गांव की"). The guard matters: the same story copied 3 times (27 Nov: the NABARD conclave) repeats its own
// lines on 3 clips too, but they start with different words, so they stay. One word is not enough to be a name: three
// stories that each repeat and all start "राजस्थान ..." must not lose that word.
// Apart from the programme, the BREAKING NEWS logo read as text ("RPEAKINC NEAS") is never a bar line.

/** A bar line on this many of the day's clips can be programme filler */
export const XV_FILLER_MIN_CLIPS = 3;
/** Leading words are the programme's name when this many different repeated lines start with them */
export const XV_PREFIX_MIN_LINES = 3;
/** Fewer bar lines than this: the anchor's opening words are read as well (README §4.2, 5) */
export const XV_MIN_BAR_LINES = 2;
/** Two readings this alike are the same line (the trial's merge threshold) */
const SAME_LINE = 0.8;
/** Words in a programme's name */
const PREFIX_WORDS = 2;
/**
 * A Latin-only line this like "breaking news" is the logo misread (27 Nov: "rpeakinc neas" 0.77, "ddeazinc nieas" 0.59;
 * real English lines 0.39 at most: "gas tanker leakage")
 */
const LOGO = "breaking news";
const LOGO_LIKE = 0.55;

const DEVANAGARI = /[\u0900-\u097F]/;
// Marks OCR drops or adds at random (chandrabindu, anusvara, nukta) and zero-width characters: left out of comparisons
const NOISY_MARKS = /[\u0901\u0902\u093C\u200B-\u200D\uFEFF]/g;

/** A line as compared: marks OCR misreads left out, spaces collapsed, Latin lowercased */
export function xvLineKey(line: string): string {
  return line.normalize("NFC").replace(NOISY_MARKS, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Length of the matched characters of a and b (Python's difflib.SequenceMatcher matching blocks, no junk) */
function matched(a: readonly string[], alo: number, ahi: number, b: readonly string[], blo: number, bhi: number): number {
  if (alo >= ahi || blo >= bhi) return 0;
  // Longest common run: the earliest in a, then the earliest in b, as difflib picks it
  let best = 0;
  let bi = alo;
  let bj = blo;
  let prev = new Array<number>(bhi - blo + 1).fill(0);
  for (let i = alo; i < ahi; i++) {
    const cur = new Array<number>(bhi - blo + 1).fill(0);
    for (let j = blo; j < bhi; j++) {
      if (a[i] !== b[j]) continue;
      const k = prev[j - blo]! + 1;
      cur[j - blo + 1] = k;
      if (k > best) {
        best = k;
        bi = i - k + 1;
        bj = j - k + 1;
      }
    }
    prev = cur;
  }
  if (!best) return 0;
  return best + matched(a, alo, bi, b, blo, bj) + matched(a, bi + best, ahi, b, bj + best, bhi);
}

/** 0-1, as Python's difflib.SequenceMatcher(None, a, b).ratio() (the trial's measure), on code points */
export function xvSimilarity(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const total = A.length + B.length;
  if (!total) return 1;
  return (2 * matched(A, 0, A.length, B, 0, B.length)) / total;
}

/** The BREAKING NEWS logo read as text: Latin only, and close to the words */
const isLogo = (key: string) => !DEVANAGARI.test(key) && xvSimilarity(key, LOGO) >= LOGO_LIKE;

/** Same line: compared on keys, with a cheap length bound first */
function sameLine(a: string, b: string): boolean {
  const la = [...a].length;
  const lb = [...b].length;
  if (!la || !lb || (2 * Math.min(la, lb)) / (la + lb) < SAME_LINE) return false;
  // difflib's quick_ratio: shared characters regardless of order, an upper bound that skips most pairs cheaply
  const counts = new Map<string, number>();
  for (const ch of a) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let shared = 0;
  for (const ch of b) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) {
      shared += 1;
      counts.set(ch, n - 1);
    }
  }
  if ((2 * shared) / (la + lb) < SAME_LINE) return false;
  return xvSimilarity(a, b) >= SAME_LINE;
}

/** One clip's bar lines as the media service read them (raw, before this file's fixes) */
export interface XvDayRead {
  clipId: string;
  lines: readonly string[];
}

/** What the day's reads say about a programme bar */
export interface XvProgramme {
  /** Keys of every reading of the filler lines */
  filler: string[];
  /** The programme's name(s), as word keys, longest first: [["गाव", "की"]] */
  prefixes: string[][];
}

interface Cluster {
  keys: string[];
  clips: Set<string>;
}

const startsWith = (words: readonly string[], prefix: readonly string[]) =>
  words.length > prefix.length && prefix.every((w, i) => words[i] === w);

/** Finds the day's programme filler (A) and the programme's name (C) from the day's screen reads */
export function xvDayProgramme(reads: readonly XvDayRead[]): XvProgramme {
  const clusters: Cluster[] = [];
  for (const read of reads) {
    for (const line of read.lines) {
      const key = xvLineKey(line);
      if (!key) continue;
      const home = clusters.find((c) => sameLine(c.keys[0]!, key) || c.keys.includes(key));
      if (home) {
        if (!home.keys.includes(key)) home.keys.push(key);
        home.clips.add(read.clipId);
      } else clusters.push({ keys: [key], clips: new Set([read.clipId]) });
    }
  }
  const repeated = clusters.filter((c) => c.clips.size >= XV_FILLER_MIN_CLIPS);

  // The programme's name: the leading words shared by several different repeated lines
  const lines = new Map<string, Set<Cluster>>();
  for (const c of repeated) {
    for (const key of c.keys) {
      const words = key.split(" ");
      if (words.length <= PREFIX_WORDS) continue;
      const p = words.slice(0, PREFIX_WORDS).join(" ");
      lines.set(p, (lines.get(p) ?? new Set()).add(c));
    }
  }
  const prefixes = [...lines].filter(([, set]) => set.size >= XV_PREFIX_MIN_LINES).map(([p]) => p.split(" "));

  const filler = repeated.filter((c) => c.keys.some((k) => prefixes.some((p) => startsWith(k.split(" "), p) || k === p.join(" ")))).flatMap((c) => c.keys);
  return { filler, prefixes };
}

export interface XvCleanLines {
  /** The lines the model gets, the programme's name cut off */
  kept: string[];
  /** Programme filler, or nothing left once the name was cut */
  dropped: string[];
}

/** One clip's bar lines with the day's programme filler dropped (A) and the programme's name cut off (C) */
export function xvCleanLines(lines: readonly string[], programme: XvProgramme): XvCleanLines {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    const key = xvLineKey(line);
    // Filler, the programme's name alone (its logo read as a line), or the BREAKING NEWS logo
    if (!key || isLogo(key) || programme.prefixes.some((p) => key === p.join(" ")) || programme.filler.some((f) => f === key || sameLine(f, key))) {
      dropped.push(line);
      continue;
    }
    let words = line.trim().split(/\s+/);
    let cut = true;
    while (cut) {
      cut = false;
      for (const p of programme.prefixes) {
        if (startsWith(words.map(xvLineKey), p)) {
          words = words.slice(p.length);
          cut = true;
          break;
        }
      }
    }
    const text = words.join(" ");
    // What is left must still be a line (the media service's own rule for a bar line)
    if (text !== line.trim() && !(text.length >= 6 && (DEVANAGARI.test(text) || text.length >= 10))) dropped.push(line);
    else if (!kept.some((k) => xvLineKey(k) === xvLineKey(text))) kept.push(text);
  }
  return { kept, dropped };
}

/** Same lines in the same order (a re-run of the model is needed when they differ) */
export const xvSameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
