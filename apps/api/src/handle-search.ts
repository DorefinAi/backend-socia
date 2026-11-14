// The editor's @ and # lookup (desk fixes 14 Nov, point 7): GET /handles?mode=prefix&kind=mention|hashtag.
//
// Exact prefix only, no fuzzy matching: a query (its leading @ or # dropped, any case) matches a handle, a name, a
// Hindi name or an alias that STARTS with it. Only known sources are searched:
//   - @: the verified handle_directory rows (SQL, routes/library.ts) and the verified entries of the worker's handle
//     files (district-, subject-, reporter- and party-handles.json), read here;
//   - #: the place tags of rajasthan-places.json (each district's Latin tag and Hindi names, each town's tag) and the
//     org's active hashtag rules (SQL).
// Each file is read again when it changes (WatchedJson); one that cannot be read gives nothing until it can.

import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import { DISTRICT_HANDLES_FILE, REPORTER_HANDLES_FILE, SUBJECT_HANDLES_FILE, WatchedJson } from "./handle-keywords";

export const PLACES_FILE = fileURLToPath(new URL("../../worker/config/rajasthan-places.json", import.meta.url));
export const PARTY_HANDLES_FILE = fileURLToPath(new URL("../../worker/config/party-handles.json", import.meta.url));

/** Results per lookup */
export const HANDLE_SEARCH_LIMIT = 10;

export type SearchKind = "mention" | "hashtag";

/** One lookup result, as the editor inserts it */
export interface HandleSearchItem {
  /** "@JaipurPolice" or "#Jaipur": inserted exactly */
  value: string;
  /** What it is: the entity, the district's police, the place */
  name: string;
  nameHi: string | null;
  /** directory (handle_directory), file (a worker handle file), places (rajasthan-places.json), rules (hashtag rules) */
  source: "directory" | "file" | "places" | "rules";
}

/** A searchable entry: the item, and every text it matches on (lowercase, NFC) */
export interface SearchEntry {
  item: HandleSearchItem;
  keys: string[];
}

const nfcLower = (s: string) => s.normalize("NFC").trim().toLowerCase();

/** The query as compared: NFC, lowercase, no leading @ or #, spaces collapsed; "" when nothing is left */
export function searchQuery(q: string | undefined | null): string {
  return typeof q === "string" ? nfcLower(q.replace(/^\s*[@#]+/, "")).replace(/\s+/g, " ") : "";
}

/** A LIKE pattern for "starts with q": q's %, _ and \ escaped */
export const prefixPattern = (q: string) => `${q.replace(/[\\%_]/g, "\\$&")}%`;

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : typeof v === "string" && v.trim() ? [v] : []);
const bare = (h: string) => h.trim().replace(/^@+/, "");

function entry(value: string, name: string, nameHi: string | null, source: HandleSearchItem["source"], keys: string[]): SearchEntry {
  return { item: { value, name, nameHi, source }, keys: [...new Set(keys.map(nfcLower).filter(Boolean))] };
}

/**
 * The verified entries of the worker's handle files as @ entries. Unverified ones are left out: the desk has not
 * decided about them. A file that is not the right shape gives none.
 */
export function fileHandleEntries(files: { district?: unknown; subject?: unknown; reporter?: unknown; party?: unknown }): SearchEntry[] {
  const out: SearchEntry[] = [];
  const add = (raw: unknown, name: string, nameHi: string | null, keys: string[]) => {
    const e = raw as { handle?: unknown; verified?: unknown } | null;
    if (!e || typeof e !== "object" || typeof e.handle !== "string" || e.verified !== true) return;
    const handle = bare(e.handle);
    if (!/^\w{1,15}$/.test(handle)) return;
    out.push(entry(`@${handle}`, name || handle, nameHi, "file", [handle, ...keys]));
  };
  const district = files.district as { state?: unknown; districts?: unknown } | null;
  for (const e of Array.isArray(district?.state) ? district.state : []) add(e, `Rajasthan ${String((e as { role?: unknown }).role ?? "")}`.trim(), null, []);
  if (district?.districts && typeof district.districts === "object") {
    for (const [d, list] of Object.entries(district.districts as Record<string, unknown>)) {
      for (const e of Array.isArray(list) ? list : []) add(e, `${d} ${String((e as { role?: unknown }).role ?? "")}`.trim(), null, [d]);
    }
  }
  for (const key of ["subject", "reporter", "party"] as const) {
    const entries = (files[key] as { entries?: unknown } | null)?.entries;
    for (const raw of Array.isArray(entries) ? entries : []) {
      const e = raw as Record<string, unknown> | null;
      if (!e || typeof e !== "object") continue;
      const hi = strs(e.names_hi);
      const name = strs(e.name)[0] ?? strs(e.names_en)[0] ?? strs(e.title)[0] ?? "";
      add(e, name, hi[0] ?? null, [...strs(e.name), ...strs(e.names_en), ...hi, ...(key === "party" ? [...strs(e.keywords_en), ...strs(e.keywords_hi)] : [])]);
    }
  }
  return out;
}

/** rajasthan-places.json as # entries: each district's Latin tag (and its Hindi names as tags), each town's tag */
export function placeTagEntries(json: unknown): SearchEntry[] {
  const districts = (json as { districts?: unknown } | null)?.districts;
  const out: SearchEntry[] = [];
  const tag = (t: string) => t.replace(/^#+/, "").replace(/[^\p{L}\p{M}\p{N}_]+/gu, "");
  for (const raw of Array.isArray(districts) ? districts : []) {
    const d = raw as { tag?: unknown; hi?: unknown; towns?: unknown } | null;
    if (!d || typeof d !== "object" || typeof d.tag !== "string" || !tag(d.tag)) continue;
    const hi = strs(d.hi);
    out.push(entry(`#${tag(d.tag)}`, d.tag, hi[0] ?? null, "places", [tag(d.tag)]));
    for (const h of hi) if (tag(h)) out.push(entry(`#${tag(h)}`, d.tag, h, "places", [tag(h)]));
    for (const rawTown of Array.isArray(d.towns) ? d.towns : []) {
      const t = rawTown as { hi?: unknown; tag?: unknown } | null;
      if (t && typeof t.tag === "string" && tag(t.tag)) out.push(entry(`#${tag(t.tag)}`, typeof t.hi === "string" ? t.hi : t.tag, typeof t.hi === "string" ? t.hi : null, "places", [tag(t.tag)]));
    }
  }
  return out;
}

/** The entries any of whose keys starts with q, in their order, each value once (any case), at most `limit` */
export function searchEntries(entries: readonly SearchEntry[], q: string, limit = HANDLE_SEARCH_LIMIT, skip: ReadonlySet<string> = new Set()): HandleSearchItem[] {
  if (!q || limit <= 0) return [];
  const out: HandleSearchItem[] = [];
  const seen = new Set(skip);
  for (const e of entries) {
    const key = e.item.value.toLowerCase();
    if (seen.has(key) || !e.keys.some((k) => k.startsWith(q))) continue;
    seen.add(key);
    out.push(e.item);
    if (out.length >= limit) break;
  }
  return out;
}

/** Merges the SQL results (first) and the file results, each value once (any case), at most `limit` */
export function mergeResults(first: readonly HandleSearchItem[], second: readonly HandleSearchItem[], limit = HANDLE_SEARCH_LIMIT): HandleSearchItem[] {
  const seen = new Set<string>();
  const out: HandleSearchItem[] = [];
  for (const item of [...first, ...second]) {
    const key = item.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** The handle and places files, searchable */
export class HandleSearchFiles {
  private readonly district: WatchedJson<unknown>;
  private readonly subject: WatchedJson<unknown>;
  private readonly reporter: WatchedJson<unknown>;
  private readonly party: WatchedJson<unknown>;
  private readonly places: WatchedJson<SearchEntry[]>;
  private built: { from: unknown[]; entries: SearchEntry[] } | null = null;

  constructor(log: FastifyBaseLogger, env = process.env) {
    const raw = (path: string) => new WatchedJson<unknown>(path, (j) => j, log);
    this.district = raw(env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE);
    this.subject = raw(env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE);
    this.reporter = raw(env.REPORTER_HANDLES_FILE ?? REPORTER_HANDLES_FILE);
    this.party = raw(env.PARTY_HANDLES_FILE ?? PARTY_HANDLES_FILE);
    this.places = new WatchedJson(env.PLACES_FILE ?? PLACES_FILE, placeTagEntries, log);
  }

  /** The @ entries of the four handle files, rebuilt when one of them changes */
  async handles(): Promise<SearchEntry[]> {
    const from = await Promise.all([this.district.get(), this.subject.get(), this.reporter.get(), this.party.get()]);
    if (!this.built || from.some((v, i) => v !== this.built!.from[i])) {
      const [district, subject, reporter, party] = from;
      this.built = { from, entries: fileHandleEntries({ district, subject, reporter, party }) };
    }
    return this.built.entries;
  }

  async placeTags(): Promise<SearchEntry[]> {
    return (await this.places.get()) ?? [];
  }
}
