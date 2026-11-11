// The breaking file's name carries the desk's tags: district code (JPR3), BIG / FULL / UPDATE, the desk or
// shift code (NDR, VKS, AM), the reporter, the date. Names are typed by hand, so every part is optional,
// any case, and in any order: BTN_RAJ_BREAKING_1303_29OCT_NDR_Bhanwar_BIG_FULL,
// btn_rj_breaking_29Oct_vks_1501_control_KTA4_big_breaking_full, BTN_RJ_BREAKING_6006_29OCT_US_CONTROL_Ashvini_dl_big.

export interface FileTags {
  /** As written, without its number: "JPR" */
  districtCode: string | null;
  /** The district it stands for ("Jaipur"), or "Delhi" for DL */
  district: string | null;
  big: boolean;
  full: boolean;
  update: boolean;
  exclusive: boolean;
  photo: boolean;
  web: boolean;
  tv: boolean;
  desk: string | null;
  reporter: string | null;
  /** As written: "29OCT", "6oct", "18SPET" */
  date: string | null;
  /** Other known codes (KARARI, NWS, MJSM, ...) */
  other: string[];
  /**
   * A token shaped like a district code with a clip number ("XYZ9") that the places file does not carry.
   * Logged, never guessed at: an unmapped code is silent data loss — the story loses the district its
   * file name states and nothing says why. Absent on stories ingested before this field existed.
   */
  unknownCode?: string | null;
}

/** A stories.file_tags value read back from the database, checked; null for anything that is not FileTags */
export function asFileTags(value: unknown): FileTags | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  const bool = (x: unknown) => x === true;
  return {
    districtCode: str(v.districtCode), district: str(v.district), big: bool(v.big), full: bool(v.full), update: bool(v.update),
    exclusive: bool(v.exclusive), photo: bool(v.photo), web: bool(v.web), tv: bool(v.tv), desk: str(v.desk), reporter: str(v.reporter),
    date: str(v.date), other: Array.isArray(v.other) ? v.other.filter((x): x is string => typeof x === "string") : [],
    unknownCode: str(v.unknownCode),
  };
}

export const DESK_CODES = ["VKS", "KS", "BPS", "NDR", "AM", "US", "VG", "MH", "YN", "RT", "VT"] as const;
const DESKS = new Set<string>(DESK_CODES);

/** Codes that are neither a flag, a desk nor a name */
const OTHER = new Set(["KARARI", "NWS", "MJSM", "SCREEN", "BLAST", "COURT", "CM", "SET", "FILE", "MEETING", "PROTOCOL", "VISITORS", "JNS", "ROOM"]);
/** The file's kind and the control room, typos included: they say nothing about the story */
const NOISE = new Set(["BTN", "RJ", "RAJ", "BREAKING", "BREAK", "BRAKING", "BREKING", "CONTROL", "CONTROLL", "CONTRL", "CONTOL", "TXT", "NEWS", "TAZA"]);
const FLAGS: Record<string, keyof Pick<FileTags, "big" | "full" | "update" | "exclusive" | "photo" | "web" | "tv">> = {
  BIG: "big", FULL: "full", FULLSCREEN: "full", UPDATE: "update", UPDATED: "update", UPDT: "update", EXCLUSIVE: "exclusive", EXCL: "exclusive",
  PHOTO: "photo", PHOTOS: "photo", WEB: "web", TV: "tv",
};

const MONTHS = "JANUARY|JANUARAY|JAN|FEBRUARY|FEB|MARCH|MAR|APRIL|APR|MAY|JUNE|JUN|JULY|JUL|AUGUST|AUG|SEPTEMBER|SEPT|SEP|SPET|OCTOBER|OCT|NOVEMBER|NOV|DECEMBER|DEC";
const DATE = new RegExp(`^\\d{1,2}(?:${MONTHS})(?:\\d{2,4})?$`);
/** 30PM, 9AM, 1230PM: a time slot, not a name */
const TIME = /^\d{1,4}(?:AM|PM)$/;
const CODE = /^([A-Z]{2,3})(\d{0,3})$/;

/** The file name without its extension, folded to the parts that carry meaning */
function tokens(fileName: string): string[] {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const stem = base.replace(/\.txt$/i, "");
  // Stray Devanagari typed into a name ("दbtn_", "_fullट") is dropped
  return stem
    .normalize("NFC")
    .replace(/[^\x20-\x7E]+/g, " ")
    .toUpperCase()
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

/**
 * `codes` maps file-name district codes to districts ("JDR" → "Jodhpur"); it comes from the places data
 * (PlaceBook.codes). DL is Delhi, always.
 */
export function fileTags(fileName: string, codes: Record<string, string>): FileTags {
  const tags: FileTags = {
    districtCode: null, district: null, big: false, full: false, update: false, exclusive: false, photo: false, web: false, tv: false,
    desk: null, reporter: null, date: null, other: [], unknownCode: null,
  };
  const name: string[] = [];
  for (const t of tokens(fileName)) {
    if (NOISE.has(t)) continue;
    const flag = FLAGS[t];
    if (flag) {
      tags[flag] = true;
      continue;
    }
    if (DESKS.has(t)) {
      tags.desk ??= t;
      continue;
    }
    if (DATE.test(t)) {
      tags.date ??= t;
      continue;
    }
    if (/^\d+$/.test(t) || TIME.test(t)) continue;
    if (OTHER.has(t)) {
      if (!tags.other.includes(t)) tags.other.push(t);
      continue;
    }
    if (t === "DL") {
      tags.districtCode ??= "DL";
      tags.district ??= "Delhi";
      continue;
    }
    const code = CODE.exec(t);
    if (code && t.length <= 6 && codes[code[1]!]) {
      tags.districtCode ??= code[1]!;
      tags.district ??= codes[code[1]!]!;
      continue;
    }
    // A code shape with a clip number that the places file does not know ("XYZ9"): not a name, so it was
    // being dropped in silence. Recorded instead, so a missing code can be found and added.
    if (code && code[2] && t.length <= 6) {
      tags.unknownCode ??= code[1]!;
      continue;
    }
    // Whatever is left is the reporter's name (one or two words), kept as written
    if (/^[A-Z]{2,}$/.test(t)) name.push(t);
  }
  tags.reporter = name.length ? name.join(" ") : null;
  return tags;
}

// ─── The reporter / bureau slot ──────────────────────────────────────────────
//
// The file name is the most reliable signal the pipeline has, and the two things it carries are told
// apart by SHAPE: a short alpha run with a clip number ("AJM3", "JPR12", "ALW9") is a district code; a
// word is the reporter's name ("PK_AGARWAL", "Rituraj", "ashish_raj"). That shape test is what makes
// "this story has no reporter" distinguishable from "this reporter is missing from the roster" — and the
// second case, logged, is how the roster gets finished.
//
// MEASURED over the 6,878 breaking files this desk has already filed (30 Oct – 10 Nov 2026):
//   64.1% carry a reporter token (143 distinct spellings)
//   39.7% carry a district code, and where the copy also names a district the two agree 92.8% of the time
//
// WHY THE COPY'S DISTRICT STILL DECIDES: on the same files the code fills a gap the copy left in only 18
// stories (0.26%), while the two disagree on 195. The district also sets the post's visible hashtag, so
// taking the handle from the file name and the hashtag from the copy would put @JaipurPolice under
// #Alwar. The code is therefore a FALLBACK and a cross-check, not an override — see handles.ts.

export interface FileSlot {
  /** The reporter token as the file name spells it, upper-cased; null when the name carries none. */
  reporterToken: string | null;
  /** District from the file name's code ("AJM3" → "Ajmer"), or null. */
  district: string | null;
  /** A code-shaped token the places file does not carry. Log it: the code table's to-do list. */
  unknownCode: string | null;
}

/** The slot from tags already parsed and stored on the story (stories.file_tags): no re-parse, no I/O. */
export function slotFromTags(tags: FileTags | null | undefined): FileSlot {
  return {
    reporterToken: tags?.reporter ?? null,
    district: tags?.district ?? null,
    unknownCode: tags?.unknownCode ?? null,
  };
}

/**
 * The reporter and district a breaking file name states. `codes` is the places file's district-code map
 * (PlaceBook.codes) — a desk-maintained table, never a guessed one, because a wrong code would tag
 * another district's police, the error class this pipeline cares most about.
 */
export function fileSlot(fileName: string, codes: Record<string, string>): FileSlot {
  return slotFromTags(fileTags(fileName, codes));
}

/** The desk's spellings of BREAKING, typos included (as in NOISE above) */
const BREAKING_WORD = /breaking|braking|breking|break/;

/** Only BREAKING files, never SCROLL or the national flash (nat_flash / nat_fash), never "x.txtbtn_...". */
export function isBreakingFileName(fileName: string): boolean {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).normalize("NFC");
  if (!/\.txt$/i.test(base)) return false;
  const lower = base.toLowerCase();
  if (!BREAKING_WORD.test(lower) || lower.includes("scroll")) return false;
  // "x.txtbtn_..." is a mis-saved double name: skip it rather than guess which half is the story
  if (lower.indexOf(".txt") !== lower.length - 4) return false;
  // A stray Devanagari letter before the name does not make nat_ files acceptable
  return !/^[^a-z]*nat_/.test(lower);
}
