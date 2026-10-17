// City and district → hashtag, from the hashtag_rules table. Deterministic and editable by the desk;
// the canonical tag is emitted, never the surface form, so जयपुर, Jaipur and "जयपुर शहर" give one tag.

import { fold } from "./fold";
import { Gazetteer, type GazetteerEntry } from "./gazetteer";

export type MatchType = "city" | "district" | "entity";
export type HashtagScript = "latin" | "devanagari";

export interface HashtagRule {
  id: string;
  matchType: MatchType;
  /** Canonical place or entity name */
  name: string;
  /** Other spellings, Devanagari and Latin */
  aliases: string[];
  hashtagLatin: string;
  hashtagDevanagari: string | null;
  priority: number;
}

export interface HashtagConfig {
  /** Whether city tags come out as #जयपुर or #Jaipur (spec §11 Q3, still open) */
  script: HashtagScript;
  /** The org's fixed tags, added after the city tags */
  fixed: string[];
  max: number;
}

export type HashtagGazetteer = Gazetteer<HashtagRule>;

export function hashtagGazetteer(rules: HashtagRule[]): HashtagGazetteer {
  const entries: GazetteerEntry<HashtagRule>[] = rules.map((r) => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases,
    priority: r.priority,
    data: r,
  }));
  return new Gazetteer(entries);
}

export function asHashtag(tag: string): string {
  const bare = tag.trim().replace(/^#+/, "").replace(/\s+/g, "");
  return bare ? `#${bare}` : "";
}

function pick(rule: HashtagRule, script: HashtagScript): string {
  return asHashtag(script === "devanagari" && rule.hashtagDevanagari ? rule.hashtagDevanagari : rule.hashtagLatin);
}

/** Matched tags by priority, then the fixed tags; duplicates dropped, capped at cfg.max. */
export function selectHashtags(text: string, gazetteer: HashtagGazetteer, cfg: HashtagConfig): string[] {
  const matched = gazetteer
    .find(text)
    .sort((a, b) => b.entry.priority - a.entry.priority || a.start - b.start)
    .map((m) => pick(m.entry.data, cfg.script));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...matched, ...cfg.fixed.map(asHashtag)]) {
    const key = fold(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= cfg.max) break;
  }
  return out;
}
