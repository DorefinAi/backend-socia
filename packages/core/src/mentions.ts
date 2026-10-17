// @mention suggestions from the verified handle directory. Never inserted on their own: the
// operator clicks to accept each one. A wrong political handle is a reputational incident.

import { Gazetteer, type GazetteerEntry } from "./gazetteer";

export interface HandleEntry {
  id: string;
  entityName: string;
  aliases: string[];
  /** Without the @ */
  handle: string;
  priority: number;
}

export interface MentionSuggestion {
  handleId: string;
  entity: string;
  handle: string;
  /** Matched on the entity's own name rather than an alias */
  exact: boolean;
}

export type HandleGazetteer = Gazetteer<HandleEntry>;

/** Build from verified rows only; unverified (staging) handles must never be eligible. */
export function handleGazetteer(entries: HandleEntry[]): HandleGazetteer {
  const items: GazetteerEntry<HandleEntry>[] = entries.map((e) => ({
    id: e.id,
    name: e.entityName,
    aliases: e.aliases,
    priority: e.priority,
    data: e,
  }));
  return new Gazetteer(items);
}

export function asMention(handle: string): string {
  const bare = handle.trim().replace(/^@+/, "");
  return bare ? `@${bare}` : "";
}

export function suggestMentions(text: string, gazetteer: HandleGazetteer, max = 2): MentionSuggestion[] {
  return gazetteer
    .find(text)
    .slice(0, max)
    .map((m) => ({ handleId: m.entry.id, entity: m.entry.data.entityName, handle: asMention(m.entry.data.handle), exact: m.exact }));
}
