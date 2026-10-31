// The breaking post's category hashtags: 1–2 topic tags after the footer tag, from the org's own hashtag rules
// (Settings → Hashtag rules, match_type "entity"). Rule-based only. A tag named in the headline outranks one
// named only in the points; within each, the rule's priority, then the earlier mention. National stories never
// get a Rajasthan-only tag (#RajasthanPolice, #RajasthanJobs, ...).

import { fold } from "../fold";
import { AVERTED_PHRASES, asHashtag, topicMatches, type HashtagGazetteer } from "../hashtags";

/** At most this many category tags; with the footer tag the post carries at most 3 */
export const MAX_CATEGORY_TAGS = 2;

/** A tag only a Rajasthan story may carry */
const RAJASTHAN_ONLY = /^#rajasthan/i;

export interface CategoryInput {
  headline: string;
  points: string[];
  rajasthan: boolean;
}

/**
 * Up to `max` category tags (Latin script, "#RoadAccident"), never one in `exclude` (the footer tag), never twice.
 * An empty gazetteer gives none.
 */
export function pickCategoryTags(story: CategoryInput, gazetteer: HashtagGazetteer | null | undefined, exclude: string[] = [], max = MAX_CATEGORY_TAGS): string[] {
  if (!gazetteer?.size || max <= 0) return [];
  const ranked = (text: string) =>
    topicMatches(text.normalize("NFC"), gazetteer).sort((a, b) => b.entry.priority - a.entry.priority || a.start - b.start);
  // Points one per line, so a negative phrase in one point does not silence the rule in another
  const matches = [...ranked(story.headline), ...ranked(story.points.join("\n"))];
  const seen = new Set(exclude.map((t) => fold(asHashtag(t))));
  const out: string[] = [];
  for (const m of matches) {
    const tag = asHashtag(m.entry.data.hashtagLatin);
    const key = fold(tag);
    if (!tag || seen.has(key)) continue;
    if (!story.rajasthan && RAJASTHAN_ONLY.test(tag)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

export interface CategorySeedRule {
  /** The rule's name (its identity when seeding: a rule of that name is never overwritten) */
  name: string;
  aliases: string[];
  /** Without the # */
  tag: string;
  priority: number;
  negativePhrases?: readonly string[];
}

/** "अस्पताल में भर्ती" is a patient, not a recruitment; a hospital alone is not ("अस्पताल में नर्स भर्ती") */
const ADMITTED_PHRASES = ["अस्पताल में भर्ती", "हॉस्पिटल में भर्ती", "इलाज", "उपचार", "घायल", "भर्ती कराया", "भर्ती करवाया", "रेफर", "आईसीयू", "ICU", "वार्ड", "ट्रॉमा"];
/** "कांटे की टक्कर" is a close contest, not a collision */
const CONTEST_PHRASES = ["कांटे की टक्कर", "कड़ी टक्कर", "टक्कर देंगे", "टक्कर देगी", "टक्कर देगा", "टक्कर दे रहे", "टक्कर दे रही"];

/**
 * The desk's category rules for phase 1 (approved 2026-10-31). Seeded only where the org has no rule of the same
 * name (apps/api: `cli seed-category-hashtags`, and local-dev socia-setup); the desk edits them in Settings.
 * Bare "धमकी" is left out on purpose ("जान से मारने की धमकी" is not a bomb threat), and so are the bare surnames
 * गहलोत and पायलट.
 */
export const CATEGORY_SEED_RULES: readonly CategorySeedRule[] = [
  // Not the bare surnames: "मुकेश गहलोत" is someone else, "पायलट प्रोजेक्ट" is not Sachin Pilot
  {
    name: "अशोक गहलोत",
    aliases: ["पूर्व मुख्यमंत्री गहलोत", "पूर्व सीएम गहलोत", "सीएम गहलोत", "गहलोत सरकार", "गहलोत राज", "Ashok Gehlot"],
    tag: "AshokGehlot",
    priority: 9,
  },
  { name: "सचिन पायलट", aliases: ["पूर्व डिप्टी सीएम पायलट", "पायलट गुट", "Sachin Pilot"], tag: "SachinPilot", priority: 9 },
  { name: "भजनलाल शर्मा", aliases: ["भजनलाल", "भजन लाल", "Bhajanlal", "Bhajanlal Sharma", "Bhajan Lal Sharma"], tag: "BhajanlalSharma", priority: 9 },
  { name: "वसुंधरा राजे", aliases: ["वसुंधरा", "Vasundhara Raje", "Vasundhara"], tag: "VasundharaRaje", priority: 9 },
  { name: "भाजपा", aliases: ["बीजेपी", "BJP", "भारतीय जनता पार्टी"], tag: "BJP", priority: 8 },
  { name: "कांग्रेस", aliases: ["कांग्रेसी", "कॉंग्रेस", "Congress"], tag: "Congress", priority: 8 },
  { name: "बम की धमकी", aliases: ["बम", "बम से उड़ाने", "उड़ाने की धमकी", "बम धमकी", "Bomb", "Bomb Threat"], tag: "BombThreat", priority: 8 },
  { name: "हाईकोर्ट", aliases: ["हाई कोर्ट", "उच्च न्यायालय", "High Court"], tag: "RajasthanHighCourt", priority: 8 },
  {
    name: "वारदात",
    aliases: ["चाकूबाजी", "चाकू बाजी", "हत्या", "हत्याकांड", "फायरिंग", "गोलीबारी", "गिरफ्तार", "गिरफ्तारी", "लूट", "लूटपाट"],
    tag: "RajasthanPolice",
    priority: 7,
  },
  {
    name: "सड़क दुर्घटना",
    aliases: ["सड़क हादसा", "सड़क हादसे", "हादसा", "हादसे", "दुर्घटना", "टक्कर", "भिड़ंत"],
    tag: "RoadAccident",
    priority: 7,
    negativePhrases: [...AVERTED_PHRASES, ...CONTEST_PHRASES],
  },
  { name: "भारी बारिश", aliases: ["मूसलाधार बारिश", "तेज बारिश", "अतिवृष्टि", "Heavy Rain"], tag: "HeavyRain", priority: 6 },
  { name: "मानसून", aliases: ["बारिश", "Monsoon"], tag: "Monsoon", priority: 5 },
  {
    name: "भर्ती परीक्षा",
    aliases: ["भर्ती", "परीक्षा", "RPSC", "RSSB", "आरपीएससी", "आरएसएसबी", "राजस्थान लोक सेवा आयोग", "कर्मचारी चयन बोर्ड"],
    tag: "RajasthanJobs",
    priority: 6,
    negativePhrases: ADMITTED_PHRASES,
  },
  { name: "ट्रेन", aliases: ["रेलवे", "रेलगाड़ी", "Train", "Railway"], tag: "Train", priority: 6 },
  { name: "तबादला", aliases: ["तबादले", "तबादलों", "IAS", "IPS", "आईएएस", "आईपीएस"], tag: "RajasthanIAS", priority: 6 },
];
