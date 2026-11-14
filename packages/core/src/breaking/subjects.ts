// The people and organisations a breaking story is about, and their X handles: the editable, hot-reloaded
// apps/worker/config/subject-handles.json. Only `verified: true` entries are used, and never a party handle
// (desk decision: no party handles). A malformed entry is skipped and reported, not fatal, so a research
// file can be dropped in as it is.

import { fold } from "../fold";
import { HANDLE } from "./syntax";
import { Gazetteer, type GazetteerEntry, type GazetteerMatch } from "../gazetteer";
import { DataFileRejected } from "./post-tags";
import { parseOffices, type Office } from "./offices";
import { subjectKeywordCandidates, type KeywordCandidate } from "./desk-handles";

export const SUBJECT_KINDS = ["person", "department", "party", "company", "institution", "police"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** One entry of subject-handles.json */
export interface SubjectHandleEntry {
  /** "@ashokgehlot51" (the @ is optional) */
  handle: string;
  kind: SubjectKind;
  title?: string;
  names_hi?: string[];
  names_en?: string[];
  keywords_hi?: string[];
  keywords_en?: string[];
  /**
   * The entry does not match a text that also has one of these (whole words, folded). @CeoRajasthan's
   * "मतदाता सूची" keywords must not fire on a panchayat roll, which is the State Election Commission's.
   */
  exclude_hi?: string[];
  exclude_en?: string[];
  /**
   * OFFERED, never tagged on its own: a seasonal or low-precision institution (@CeoRajasthan: 109 tags on
   * 9 Sep, municipal-election day, and essentially none on the other five capture days). The desk can make it
   * routine for a stretch with `emit_window` (an SIR or a roll revision) without a code change.
   */
  suggest_only?: boolean;
  /** With suggest_only: the IST days (YYYY-MM-DD, inclusive) the entry IS tagged, like a campaign window */
  emit_window?: { start: string; end: string };
  verified: boolean;
  source?: string;
  checkedAt?: string;
  note?: string;
}

/** subject-handles.json */
export interface SubjectHandlesData {
  version: number;
  entries: SubjectHandleEntry[];
}

export interface SubjectData {
  /** Handle without the @ */
  handle: string;
  kind: Exclude<SubjectKind, "party">;
  title: string;
  /** Which spellings are names (the rest are keywords) */
  names: string[];
  /** Folded words or phrases that stop the entry matching a text that has them */
  excludes?: string[];
  /** Offered, not tagged, outside `emitWindow` (subject-handles.json suggest_only) */
  suggestOnly?: boolean;
  emitWindow?: { start: string; end: string };
}

const IST_DAY = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Whether the entry may go on the post by itself at `at` (no time given: only an entry that is not suggest-only) */
export function subjectEmits(data: SubjectData, at?: Date): boolean {
  if (!data.suggestOnly) return true;
  if (!data.emitWindow || !at) return false;
  const day = IST_DAY(at);
  return day >= data.emitWindow.start && day <= data.emitWindow.end;
}

/** A gazetteer that drops an entry from a text naming one of the entry's exclusions */
class SubjectGazetteer extends Gazetteer<SubjectData> {
  override find(text: string): GazetteerMatch<SubjectData>[] {
    return super.find(text).filter((m) => !subjectExcluded(m, text));
  }
}

/**
 * Whether `context` names one of the match's exclusions. Pass the WHOLE post: the headline and the points are
 * matched separately, and "मतदाता सूची" in the headline must still be dropped when "पंचायत" is only in a point.
 */
export function subjectExcluded(m: GazetteerMatch<SubjectData>, context: string): boolean {
  const excludes = m.entry.data.excludes;
  if (!excludes?.length) return false;
  const f = ` ${fold(context.normalize("NFC"))} `;
  return excludes.some((x) => f.includes(` ${x} `));
}

/** The verified, taggable subjects, ready to match */
export interface SubjectRules {
  gazetteer: Gazetteer<SubjectData>;
  count: number;
  /**
   * Every handle in the file, whatever its entry (unverified, party, no names), lowercase without the @: the
   * desk-added handles rule never tags these or their lookalikes (desk-handles.ts)
   */
  handles?: ReadonlySet<string>;
  /** `offices`: an office named without its holder, offered only (offices.ts) */
  offices?: readonly Office[];
  /** The verified, non-party English names and keywords as handle keyword candidates (desk-handles.ts subjectKeywordCandidates) */
  keywordCandidates?: readonly KeywordCandidate[];
}

export const EMPTY_SUBJECT_RULES: SubjectRules = { gazetteer: new SubjectGazetteer([]), count: 0 };

const KINDS = new Set<string>(SUBJECT_KINDS);

/** Every key an entry may carry: a misspelt one ("suggestonly") must not be ignored, it rejects the file */
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "handle", "kind", "title", "names_hi", "names_en", "keywords_hi", "keywords_en", "exclude_hi", "exclude_en", "suggest_only", "emit_window",
  "verified", "source", "checkedAt", "evidence", "note",
]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: "2026-13-45" is shaped like one and is not */
const realDay = (d: unknown): d is string => {
  if (typeof d !== "string" || !DAY.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.normalize("NFC").trim()) : []);

/**
 * Checks a parsed subject-handles.json. The root must be `{ entries: [...] }` (else it throws, and the worker keeps
 * its last good copy); an unverified or party entry is left out silently.
 *
 * Two kinds of problem. The keys that decide WHETHER A HANDLE IS TAGGED (suggest_only, emit_window) and any key
 * the file does not know (a misspelt "suggestonly" would silently make a seasonal handle routine) reject the
 * WHOLE FILE (DataFileRejected, every problem listed), as campaigns.json and hashtag-normalise.json do. The older
 * entry checks (handle, kind, verified, names) still skip and report the one entry: this file takes research
 * drops as they are, and those checks can only make a handle NOT tagged.
 */
export function parseSubjectHandles(json: unknown, problem: (message: string) => void = () => undefined): SubjectRules {
  const root = json as Partial<SubjectHandlesData> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.entries)) throw new Error("subject handles: expected { version, entries: [...] }");
  const entries: { id: string; name: string; aliases: string[]; priority: number; data: SubjectData }[] = [];
  const handles = new Set<string>();
  const rejects: string[] = [];
  const reject = (m: string) => {
    rejects.push(m);
    problem(m);
  };
  root.entries.forEach((raw, i) => {
    const h = (raw as { handle?: unknown } | null)?.handle;
    if (raw && typeof raw === "object") {
      const who = `entries[${i}]${typeof h === "string" ? ` (${h})` : ""}`;
      for (const k of Object.keys(raw)) if (!ENTRY_KEYS.has(k) && !k.startsWith("_")) reject(`${who}: unknown key "${k}"`);
      const r = raw as Partial<SubjectHandleEntry>;
      if (r.suggest_only !== undefined && typeof r.suggest_only !== "boolean") reject(`${who}: "suggest_only" must be true or false`);
      const w = r.emit_window;
      if (w !== undefined) {
        if (!(w && typeof w === "object" && realDay(w.start) && realDay(w.end) && w.start <= w.end)) {
          reject(`${who}: "emit_window" must be { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }, real days, start first`);
        } else if (r.suggest_only !== true) reject(`${who}: "emit_window" only means something with "suggest_only": true`);
      }
    }
    if (typeof h === "string" && HANDLE.test(h.trim())) handles.add(h.trim().replace(/^@/, "").toLowerCase());
    const e = raw as Partial<SubjectHandleEntry> | null;
    const where = `entries[${i}]`;
    if (!e || typeof e !== "object") return problem(`${where}: not an object`);
    if (typeof e.handle !== "string" || !HANDLE.test(e.handle.trim())) return problem(`${where}: "${String(e.handle)}" is not an X handle`);
    if (!KINDS.has(String(e.kind))) return problem(`${where} (${e.handle}): kind must be one of ${SUBJECT_KINDS.join(", ")}`);
    if (typeof e.verified !== "boolean") return problem(`${where} (${e.handle}): "verified" must be true or false`);
    if (!e.verified || e.kind === "party") return;
    const names = [...strings(e.names_hi), ...strings(e.names_en)];
    const keywords = [...strings(e.keywords_hi), ...strings(e.keywords_en)];
    if (!names.length && !keywords.length) return problem(`${where} (${e.handle}): no names or keywords to match`);
    const handle = e.handle.trim().replace(/^@/, "");
    const excludes = [...strings(e.exclude_hi), ...strings(e.exclude_en)].map((x) => fold(x)).filter(Boolean);
    const w = e.emit_window;
    const [first, ...rest] = [...names, ...keywords];
    entries.push({
      id: `${handle.toLowerCase()}#${i}`,
      name: first!,
      aliases: rest,
      // Names outrank keywords on the same words
      priority: names.length ? 1 : 0,
      data: {
        handle, kind: e.kind as SubjectData["kind"], title: typeof e.title === "string" ? e.title : handle, names, ...(excludes.length > 0 && { excludes }),
        ...(e.suggest_only && { suggestOnly: true }), ...(e.suggest_only && w && { emitWindow: { start: w.start, end: w.end } }),
      },
    });
  });
  // An office named without its holder (reporter-prior brief §6): its handles must be entries of this file
  const office = parseOffices((root as { offices?: unknown }).offices, handles, (root as { office_exclusion_lists?: unknown }).office_exclusion_lists);
  for (const m of office.problems) reject(m);
  if (rejects.length) throw new DataFileRejected("subject-handles", rejects);
  return { gazetteer: new SubjectGazetteer(entries), count: entries.length, handles, offices: office.offices, keywordCandidates: subjectKeywordCandidates(json) };
}
