// Per-user keyboard shortcuts (users.prefs.keyBindings): the body schema of PUT /me/key-bindings, the read side
// for GET /me, and the clash check. Action ids are the desk's (the API does not keep a list of them, so a new desk
// action needs no backend change); an action left out uses the desk's default keys, [] turns it off.

import { Type } from "@fastify/type-provider-typebox";

export const MAX_ACTIONS = 80;
export const MAX_COMBOS = 2;
const ACTION_MAX = 40;

/** "desk.next", "story.publish2": lowercase dotted segments, at most 40 characters */
export const ACTION_ID = "^[a-z][a-z0-9]*(\\.[a-z0-9]+)*$";
/** Up to 3 modifiers, then one key: a lowercase name ("j", "enter", "arrowdown") or one punctuation key */
export const KEY_COMBO =
  "^((mod|ctrl|alt|shift|meta)\\+){0,3}[a-z0-9]{1,12}$|^((mod|ctrl|alt|shift|meta)\\+){0,3}[\\[\\]\\-=,./;'`\\\\]$";

const actionRe = new RegExp(ACTION_ID);
const comboRe = new RegExp(KEY_COMBO);

/** The length cap sits in the key pattern (a lookahead), so the schema alone refuses a long id */
const ACTION_KEY = `^(?=.{1,${ACTION_MAX}}$)(?:${ACTION_ID.slice(1, -1)})$`;

export const KeyBindingsBody = Type.Object(
  {
    bindings: Type.Record(
      Type.String({ pattern: ACTION_KEY }),
      Type.Array(Type.String({ pattern: KEY_COMBO, maxLength: 40 }), { maxItems: MAX_COMBOS }),
      { additionalProperties: false, maxProperties: MAX_ACTIONS },
    ),
  },
  { additionalProperties: false },
);

export type KeyBindings = Record<string, string[]>;

const isValidMap = (v: unknown): v is KeyBindings => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return (
    entries.length <= MAX_ACTIONS &&
    entries.every(([k, combos]) => k.length <= ACTION_MAX && actionRe.test(k) && Array.isArray(combos) && combos.length <= MAX_COMBOS && combos.every((c) => typeof c === "string" && comboRe.test(c)))
  );
};

/** users.prefs -> the keyBindings GET /me returns: {} when unset, and also {} for anything malformed */
export function readKeyBindings(prefs: unknown): KeyBindings {
  const kb = prefs && typeof prefs === "object" ? (prefs as { keyBindings?: unknown }).keyBindings : undefined;
  return isValidMap(kb) ? kb : {};
}

/**
 * The checks the schema cannot make: a body that passed it is still refused here for a key outside the allowed
 * set (a defence if the schema compiler ever ignored a keyword), a modifier given twice ("shift+shift+k") or a combo
 * listed twice in one action. Returns the message, or null when fine.
 */
export function invalidBindings(bindings: KeyBindings): string | null {
  if (!isValidMap(bindings)) return "Those shortcuts are not in the expected shape.";
  for (const [action, combos] of Object.entries(bindings)) {
    const seen = new Set<string>();
    for (const combo of combos) {
      const mods = combo.split("+").slice(0, -1);
      if (new Set(mods).size !== mods.length) return `"${combo}" (${action}) names a modifier twice.`;
      const key = canonical(combo);
      if (seen.has(key)) return `"${combo}" is listed twice for ${action}.`;
      seen.add(key);
    }
  }
  return null;
}

/** Modifiers in a fixed order, so "shift+mod+k" and "mod+shift+k" are one combo */
function canonical(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop()!;
  return [...parts.sort(), key].join("+");
}

/**
 * The combos a canonical combo can mean on some computer: "mod" is ctrl on Windows/Linux and meta (Cmd) on a Mac,
 * and the shortcuts follow the user to any computer, so "mod+k" clashes with both "ctrl+k" and "meta+k".
 */
function meanings(combo: string): string[] {
  const parts = combo.split("+");
  const key = parts.pop()!;
  if (!parts.includes("mod")) return [canonical(combo)];
  const rest = parts.filter((m) => m !== "mod");
  return ["ctrl", "meta"].filter((m) => !rest.includes(m)).map((m) => canonical([...rest, m, key].join("+")));
}

export interface KeyClash {
  /** The combos as the user typed them ("mod+k", "ctrl+k") */
  combos: string[];
  actions: string[];
}

/** Combos that two or more actions share (after the mod/ctrl/meta reading above), each with the actions involved */
export function findClashes(bindings: KeyBindings): KeyClash[] {
  const owners = new Map<string, { combos: Set<string>; actions: Set<string> }>();
  for (const [action, combos] of Object.entries(bindings)) {
    for (const combo of combos) {
      for (const m of meanings(combo)) {
        const o = owners.get(m) ?? { combos: new Set<string>(), actions: new Set<string>() };
        o.combos.add(combo);
        o.actions.add(action);
        owners.set(m, o);
      }
    }
  }
  const out: KeyClash[] = [];
  const reported = new Set<string>();
  for (const o of owners.values()) {
    if (o.actions.size < 2) continue;
    const clash = { combos: [...o.combos].sort(), actions: [...o.actions].sort() };
    const id = JSON.stringify(clash);
    if (reported.has(id)) continue;
    reported.add(id);
    out.push(clash);
  }
  return out;
}

export const clashMessage = (clashes: KeyClash[]): string =>
  "Two actions share a shortcut: " +
  clashes.map((c) => `${c.combos.map((k) => `"${k}"`).join(" / ")} is used by ${c.actions.join(" and ")}`).join("; ") +
  ". Give each action its own keys.";
