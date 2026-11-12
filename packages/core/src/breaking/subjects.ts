// The people and organisations a breaking story is about, and their X handles: the editable, hot-reloaded
// apps/worker/config/subject-handles.json. Only `verified: true` entries are used, and never a party handle
// (desk decision: no party handles). A malformed entry is skipped and reported, not fatal, so a research
// file can be dropped in as it is.

import { fold } from "../fold";
import { Gazetteer, type GazetteerEntry, type GazetteerMatch } from "../gazetteer";

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
}

export const EMPTY_SUBJECT_RULES: SubjectRules = { gazetteer: new SubjectGazetteer([]), count: 0 };

const HANDLE = /^@?\w{1,15}$/;
const KINDS = new Set<string>(SUBJECT_KINDS);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.normalize("NFC").trim()) : []);

/**
 * Checks a parsed subject-handles.json. The root must be `{ entries: [...] }` (else it throws, and the worker keeps
 * its last good copy); an entry that is malformed is skipped and reported through `problem`; an unverified or
 * party entry is left out silently.
 */
export function parseSubjectHandles(json: unknown, problem: (message: string) => void = () => undefined): SubjectRules {
  const root = json as Partial<SubjectHandlesData> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.entries)) throw new Error("subject handles: expected { version, entries: [...] }");
  const entries: { id: string; name: string; aliases: string[]; priority: number; data: SubjectData }[] = [];
  const handles = new Set<string>();
  root.entries.forEach((raw, i) => {
    const h = (raw as { handle?: unknown } | null)?.handle;
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
    const [first, ...rest] = [...names, ...keywords];
    entries.push({
      id: `${handle.toLowerCase()}#${i}`,
      name: first!,
      aliases: rest,
      // Names outrank keywords on the same words
      priority: names.length ? 1 : 0,
      data: { handle, kind: e.kind as SubjectData["kind"], title: typeof e.title === "string" ? e.title : handle, names, ...(excludes.length > 0 && { excludes }) },
    });
  });
  return { gazetteer: new SubjectGazetteer(entries), count: entries.length, handles };
}
