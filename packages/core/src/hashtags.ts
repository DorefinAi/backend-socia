// Hashtags from the hashtag_rules table. Deterministic and editable by the desk; the canonical tag is
// emitted, never the surface form, so जयपुर, Jaipur and "जयपुर शहर" give one tag. City and district rules
// give the First India post's line-1 #District; topic rules (match_type "entity") fill the tag line.

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
  /**
   * The rule does not fire from a sentence that also has one of these (whole words, folded), so the accident
   * rule skips "बड़ा हादसा टल गया". It still fires from any other sentence of the text that names it.
   */
  negativePhrases?: string[];
}

/** Averted / narrowly escaped: the negative phrases of the accident topic rule (seed and migration 0012) */
export const AVERTED_PHRASES: readonly string[] = [
  "टल", "टला", "टली", "टले", "होने से बचा", "होने से बची", "होने से बचे", "होने से बच गया", "होने से बच गई",
  "बाल-बाल बचा", "बाल-बाल बची", "बाल-बाल बचे", "averted", "narrowly escaped", "narrowly avoided", "near miss",
];

export interface HashtagConfig {
  /** Whether city tags come out as #जयपुर or #Jaipur (spec §11 Q3, still open) */
  script: HashtagScript;
  /** The org's fixed tags: first in the First India tag line (selectTagLine), after the matches in selectHashtags */
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

/** Sentence ends, Devanagari and Latin; fold() would turn them into spaces, so split first */
const SENTENCE_END = /[।॥.!?\n]+/u;

/**
 * gazetteer.find, minus rules whose every naming sentence also has one of the rule's negative phrases.
 * Rules without negative phrases are untouched (one find over the whole text, as before).
 */
function findRules(text: string, gazetteer: HashtagGazetteer): ReturnType<HashtagGazetteer["find"]> {
  const found = gazetteer.find(text);
  if (!found.some((m) => m.entry.data.negativePhrases?.length)) return found;
  const sentences = text.split(SENTENCE_END).map((s) => ({ folded: ` ${fold(s)} `, ids: new Set(gazetteer.find(s).map((m) => m.entry.id)) }));
  return found.filter((m) => {
    const negatives = (m.entry.data.negativePhrases ?? []).map((p) => fold(p)).filter(Boolean);
    if (!negatives.length) return true;
    return sentences.some((s) => s.ids.has(m.entry.id) && !negatives.some((p) => s.folded.includes(` ${p} `)));
  });
}

function pick(rule: HashtagRule, script: HashtagScript): string {
  return asHashtag(script === "devanagari" && rule.hashtagDevanagari ? rule.hashtagDevanagari : rule.hashtagLatin);
}

/** Matched tags by priority, then the fixed tags; duplicates dropped, capped at cfg.max. */
export function selectHashtags(text: string, gazetteer: HashtagGazetteer, cfg: HashtagConfig): string[] {
  const matched = findRules(text, gazetteer)
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

/** Shown when no topic rule matched and the org has no fixed tag, so the tag line always carries the brand */
export const FALLBACK_TOPIC_TAG = "#FirstIndiaNews";

/** Which rules feed which part of the First India post: places go in line 1, topics in the tag line */
const PLACE_TYPES: ReadonlySet<MatchType> = new Set(["city", "district"]);

/**
 * The district as line 1's hashtag, always in Latin script (Sawai Madhopur → #SawaiMadhopur). The
 * gazetteer's tag when the place is in it, else built from the name: words capitalised, spaces dropped.
 */
export function districtHashtag(place: string, gazetteer: HashtagGazetteer): string {
  const found = gazetteer.find(place).find((m) => PLACE_TYPES.has(m.entry.data.matchType));
  if (found) return asHashtag(found.entry.data.hashtagLatin);
  const words = place.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  return asHashtag(words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(""));
}

/**
 * The First India tag line: the org's fixed tags first, then topic tags (entity rules matched in the
 * text) by priority, capped at cfg.max. Place rules are left out (the district is in line 1), and so is
 * anything in `exclude`. No topic matched and no fixed tag: FALLBACK_TOPIC_TAG (one brand tag, never two).
 */
export function selectTagLine(text: string, gazetteer: HashtagGazetteer, cfg: HashtagConfig, exclude: string[] = []): string[] {
  const topics = findRules(text, gazetteer)
    .filter((m) => !PLACE_TYPES.has(m.entry.data.matchType))
    .sort((a, b) => b.entry.priority - a.entry.priority || a.start - b.start)
    .map((m) => pick(m.entry.data, cfg.script));

  const out: string[] = [];
  const seen = new Set(exclude.map((t) => fold(asHashtag(t))));
  const add = (tag: string) => {
    const key = fold(tag);
    if (!tag || seen.has(key) || out.length >= cfg.max) return false;
    seen.add(key);
    out.push(tag);
    return true;
  };
  cfg.fixed.map(asHashtag).forEach(add);
  const added = topics.map(add).filter(Boolean).length;
  if (!added && !out.length) add(FALLBACK_TOPIC_TAG);
  return out;
}
