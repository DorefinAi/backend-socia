// What kind of account a directory handle is (reporter directory changes v2, R2, 13 Nov 2026).
//
//   institution  an organisation's account: @RajGovOfficial, @INCRajasthan, @BJP4Rajasthan, a department (the owner
//                says "organisation"; the files and the code say "institution" — the same thing)
//   person       one person's account: the CM (@BhajanlalBjp), the Chief Secretary, a minister, an MLA, a reporter
//   district     an account tied to one district: its police, collector or administration (@jaipur_police, @DcDmJaipur)
//   police       a police force that is NOT one district's (owner decision P3, 15 Nov 2026): the state police
//                (@PoliceRajasthan, @RajPoliceHelp), the ACB (@AcbRajasthan), another state's (@DelhiPolice), and every
//                central armed police force in the directory (@crpfindia; @BSF_India by decision D2 — no CISF, ITBP,
//                SSB, NSG or RPF handle is in the directory yet; one added later is typed "police" too). Until P3 / D2
//                these were "institution", so a reporter whose seed listed @AcbRajasthan would have had it offered.
//
// Every entry of every directory file (district-, subject-, party- and reporter-handles.json) carries its
// `handle_type`; an entry without a valid one is rejected by its loader, the rest of the file still loads.
//
// WHAT IT DECIDES: the reporter prior offers INSTITUTION handles only — never police, collector, admin (the Settings
// types, all "district" here) or district. A person comes from the copy (name and office matching), never from who
// filed the story: Aishwarya → @BhajanlalBjp was right 52 times out of 52, and the text named the CM all 52 times. A
// district account comes from the story's own district, never from the reporter's usual one: Satya → @jaipur_police
// on a Tonk story is the wrong police force on a public post. A police account comes from the copy or the story's
// class (crime, a police venue), never from who filed it. A declared beat offers institutions and persons only (P6).
// It also orders the desk's suggestions (compose.ts rankHandleSuggestions): a person or office the copy names comes
// first; "police" ranks exactly where "institution" and "district" do (the other text rules), so P3 moves nothing.
//
// What "police" does NOT change (P3, 15 Nov): normal tagging (the district- and state-police rules read the files'
// `role` / `kind`, not this type), the guards built from `role` (HandleRules.bound), the desk's ranking, and the
// Settings mapping (a Settings "police" row is still "district" here: settingsHandleType below).

export const HANDLE_TYPES = ["institution", "person", "district", "police"] as const;
export type HandleType = (typeof HANDLE_TYPES)[number];

const TYPES: ReadonlySet<string> = new Set(HANDLE_TYPES);

export const isHandleType = (v: unknown): v is HandleType => typeof v === "string" && TYPES.has(v);

/** The loaders' message for an entry whose handle_type is missing or wrong, or null when it is valid */
export function handleTypeProblem(v: unknown): string | null {
  if (isHandleType(v)) return null;
  return v === undefined
    ? `"handle_type" is missing (one of ${HANDLE_TYPES.join(", ")})`
    : `"handle_type" ${JSON.stringify(v)} is not one of ${HANDLE_TYPES.join(", ")}`;
}

/**
 * The only types the reporter prior's MEASURED handles may have (owner decision P3, 15 Nov 2026): institution. Never
 * police, collector, admin or district — and never a person (R2).
 */
export const PRIOR_HANDLE_TYPES: ReadonlySet<HandleType> = new Set<HandleType>(["institution"]);

/** Whether the measured prior may offer a handle of this type (undefined: no known type, so never) */
export const isPriorHandleType = (t: HandleType | undefined): boolean => t !== undefined && PRIOR_HANDLE_TYPES.has(t);

/**
 * The only types a declared beat may offer (owner decision P6, 15 Nov 2026): institution and person, exactly these
 * lower-case words. Any other value — "district", "police", a misspelt "District" (which its loader rejects, so the
 * handle has no type at all) — leaves the handle out.
 */
export const BEAT_HANDLE_TYPES: ReadonlySet<HandleType> = new Set<HandleType>(["institution", "person"]);

/** Whether a declared beat may offer a handle of this type (undefined: no known type, so never) */
export const isBeatHandleType = (t: HandleType | undefined): boolean => t !== undefined && BEAT_HANDLE_TYPES.has(t);

/**
 * How far a type is from an institution: when two files disagree about a handle, the further one wins. "police" is
 * the strictest (P3: at least as strict as district), so a disagreement about a police account never makes it a prior
 * or beat candidate, and a police/district dispute keeps the narrower word.
 */
const RESTRICTION: Readonly<Record<HandleType, number>> = { institution: 0, person: 1, district: 2, police: 3 };

/**
 * One handle → type map from several files' maps (lower-cased handles without the @). Where two files disagree the
 * most restrictive type wins (police over district over person over institution), so a disagreement can only ever
 * take a handle OUT of the reporter prior, never put one in.
 */
export function mergeHandleTypes(...maps: (ReadonlyMap<string, HandleType> | null | undefined)[]): Map<string, HandleType> {
  const out = new Map<string, HandleType>();
  for (const m of maps) {
    for (const [h, t] of m ?? []) {
      const k = h.replace(/^@/, "").toLowerCase();
      const cur = out.get(k);
      if (!cur || RESTRICTION[t] > RESTRICTION[cur]) out.set(k, t);
    }
  }
  return out;
}

/** Adds one entry's type to a loader's map, keeping the more restrictive one when the file lists the handle twice */
export function addHandleType(map: Map<string, HandleType>, handle: string, type: HandleType): void {
  const k = handle.trim().replace(/^@/, "").toLowerCase();
  const cur = map.get(k);
  if (!cur || RESTRICTION[type] > RESTRICTION[cur]) map.set(k, type);
}

// ─── Settings handle types (handle fixes F1, 14 Nov 2026) ───────────────────────────────────────────────
//
// A handle added in Settings (handle_directory source "manual", or promoted from Wikidata staging) carries one of
// the owner's six types (handle_directory.entity_type, migration 0029). Only police, collector and admin handles
// may be matched by the story's district; every other type only on its own keywords and names in the copy.

export const SETTINGS_HANDLE_TYPES = ["police", "collector", "admin", "organisation", "person", "party"] as const;
export type SettingsHandleType = (typeof SETTINGS_HANDLE_TYPES)[number];

const SETTINGS_TYPES: ReadonlySet<string> = new Set(SETTINGS_HANDLE_TYPES);
export const isSettingsHandleType = (v: unknown): v is SettingsHandleType => typeof v === "string" && SETTINGS_TYPES.has(v);

/** The Settings types that may be matched by district: the district's police, collector and administration */
export const DISTRICT_MATCHED_TYPES: ReadonlySet<SettingsHandleType> = new Set<SettingsHandleType>(["police", "collector", "admin"]);

/**
 * A Settings type as the code's types: police/collector/admin → district, organisation/party → institution, person →
 * person. A Settings "police" row stays "district" (P3 added the directory files' "police" type, not this mapping):
 * a Settings police handle is a district force matched by the stated district.
 */
export function settingsHandleType(t: SettingsHandleType): HandleType {
  return DISTRICT_MATCHED_TYPES.has(t) ? "district" : t === "person" ? "person" : "institution";
}
