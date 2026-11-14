// What kind of account a directory handle is (reporter directory changes v2, R2, 13 Nov 2026).
//
//   institution  an organisation's account: @RajGovOfficial, @INCRajasthan, @BJP4Rajasthan, a department
//   person       one person's account: the CM (@BhajanlalBjp), the Chief Secretary, a minister, an MLA, a reporter
//   district     an account tied to one district: its police, collector or administration (@jaipur_police, @DcDmJaipur)
//
// Every entry of every directory file (district-, subject-, party- and reporter-handles.json) carries its
// `handle_type`; an entry without a valid one is rejected by its loader, the rest of the file still loads.
//
// WHAT IT DECIDES: the reporter prior offers INSTITUTION handles only. A person comes from the copy (name and office
// matching), never from who filed the story: Aishwarya → @BhajanlalBjp was right 52 times out of 52, and the text
// named the CM all 52 times. A district account comes from the story's own district, never from the reporter's usual
// one: Satya → @jaipur_police on a Tonk story is the wrong police force on a public post. It also orders the desk's
// suggestions (compose.ts rankHandleSuggestions): a person or office the copy names comes first.

export const HANDLE_TYPES = ["institution", "person", "district"] as const;
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

/** How far a type is from an institution: when two files disagree about a handle, the further one wins */
const RESTRICTION: Readonly<Record<HandleType, number>> = { institution: 0, person: 1, district: 2 };

/**
 * One handle → type map from several files' maps (lower-cased handles without the @). Where two files disagree the
 * most restrictive type wins (district over person over institution), so a disagreement can only ever take a handle
 * OUT of the reporter prior, never put one in.
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
