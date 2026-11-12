// Replay harness: scores the hashtags we put on a post against the ones the desk really wrote.
//
// This is the hashtag twin of replay.ts, and it exists for the same reason: every argument about which
// tags to apply — should a topic rule fire automatically, is the footer rule right, does a category tag
// help — was settled by reasoning, and the reasoning was wrong. Run it against an export of the
// account's own timeline and the corpus answers instead.
//
// INPUT: `{ "tweets": [ { "text": "...", ... }, ... ] }`, the same export shape replay.ts takes. Get it
// free from X's "Download an archive of your data".
//
// WHAT IT MEASURES, and the one thing to be careful about: the leading run (`#Jaipur #डग:`) is COPIED
// from the district and town the parser already found, so scoring it against the tag it was copied from
// is circular and says nothing. Only the TRAILING run is scored — the footer tag and any topic tags —
// because that is the part the rules actually decide.
//
// WHAT GOOD LOOKS LIKE, measured on the 400 posts of 30 Oct 2026, trailing run, structural tags:
//
//                        precision   recall   exact set   brand
//   all 400 posts          90.5%     54.0%      55.3%      95.0%
//   the 307 format-A       93.8%     72.4%      71.3%      99.3%   ← the shape this pipeline composes
//
// Before the footer-only change precision was 55.8% and the exact set 24.3%: the topic rules were
// applied to the post and were wrong far more often than right — #RajasthanElection fired on 111 posts
// and the desk had used it on NONE of them, and only 2 of the org's 19 active rules beat a coin flip.
// They are offered to the desk now, which is what the precision above buys.
//
// The recall that is left is almost all one thing: #RajasthanPanchayatElection2026, which the desk put
// on 58 posts of a polling day and we have no rule for. That is a campaign tag with a date window, and
// it is the first thing to add if this number is to move.
//
// The other two formats in the corpus are not ours: format B is a video post (`Title | Rajasthan News`,
// 31 posts) and format C puts the district in the trailing run instead of the lead (62 posts). This
// pipeline composes neither, so a low score there measures nothing about it.

import { readFileSync } from "node:fs";
import { CATEGORY_SEED_RULES } from "../src/breaking/categories";
import { composeBreaking } from "../src/breaking/compose";
import { EMPTY_HANDLE_RULES } from "../src/breaking/handles";
import { hashtagGazetteer, type HashtagGazetteer } from "../src/hashtags";
import { PlaceBook, parsePlacesData } from "../src/breaking/places";
import { normaliseTag as normaliseShared, parseHashtagNormalise, postFormat, segmentPost, type Segmented } from "../src/breaking/post-tags";

export interface CorpusPost {
  text: string;
}

// Slots, format and normalisation are the shared ones (src/breaking/post-tags.ts), so the harness and the
// composer cannot drift apart: URLs stripped first (§2.1), the danda attached to the word before it counts as
// a video separator (§2.2), accented Latin tags (§2.6), and the desk's typos normalised before scoring (§2.7).
const DEVANAGARI = /[ऀ-ॿ]/;
const NORMALISER = parseHashtagNormalise(JSON.parse(readFileSync(new URL("../../../apps/worker/config/hashtag-normalise.json", import.meta.url), "utf8")));
export const normaliseTag = (h: string) => normaliseShared(h, NORMALISER).tag;
export { postFormat, segmentPost, type Segmented };

/**
 * Tags the desk reaches for again and again, which we have no rule for. They are counted as ground truth
 * on purpose: filtering the comparison down to the tags we can already produce would score us against
 * our own vocabulary and hide the gap. Observed 3+ times on 30 Oct 2026.
 */
const RECURRING = new Set([
  "RajasthanPanchayatElection2026", "RajasthanPanchayatElection", "PanchayatElection", "RajasthanNews",
  "WeatherUpdate", "BreakingNews", "HindiNews", "Rajasthan", "SupremeCourt", "PMModi", "CMBhajanlalSharma",
  "IASShikharAgrawal", "ShikharAgrawalAPO",
]);

/**
 * Tags a rule could be expected to produce, as opposed to the per-story SEO tail: 83% of the desk's
 * topic tags are used exactly once and no rule can invent those.
 */
export function isStructural(tag: string, districts: ReadonlySet<string>): boolean {
  if (tag === "RajasthanWithFirstIndia" || tag === "FirstIndiaNews" || tag === "FINVideo") return true;
  if (districts.has(tag) || RECURRING.has(tag)) return true;
  if (/^[A-Z][A-Za-z]+News$/.test(tag)) return true;
  return CATEGORY_SEED_RULES.some((r) => r.tag === tag);
}

export interface Report {
  posts: number;
  precision: number;
  recall: number;
  exact: number;
  brand: { ok: number; of: number };
  /** Tags we put on a post the desk had not written, most frequent first */
  wrong: [string, number][];
  /** Tags the desk wrote that we did not produce */
  missed: [string, number][];
}

/**
 * Scores the trailing run our composer produces against the desk's own.
 *
 * `structuralOnly` drops the per-story SEO tail from the ground truth (83% of the desk's topic tags are
 * used exactly once and are not derivable from the text) — without it recall is measuring whether we can
 * invent one-off tags, which no rule can.
 */
export function replayHashtags(posts: readonly CorpusPost[], book: PlaceBook, topics: HashtagGazetteer | null, structuralOnly = true): Report {
  const districts = new Set(book.districts.map((d) => d.tag));
  let tp = 0, got = 0, want = 0, exact = 0, brandOk = 0, brandOf = 0;
  const wrong = new Map<string, number>();
  const missed = new Map<string, number>();
  const BRANDS = new Set(["RajasthanWithFirstIndia", "FirstIndiaNews"]);

  for (const p of posts) {
    const s = segmentPost(p.text);
    const district = s.lead[0] && !DEVANAGARI.test(s.lead[0]) ? normaliseTag(s.lead[0]) : null;
    const town = s.lead[1] && DEVANAGARI.test(s.lead[1]) ? s.lead[1] : null;
    const place = book.district(district);
    const draft = composeBreaking(
      { headline: s.headline, points: s.points, district, town, rajasthan: place ? place.rajasthan : true, leaderPost: false },
      EMPTY_HANDLE_RULES, book, { topics },
    );
    const ours = new Set(draft.hashtags.map((t) => normaliseTag(t.replace(/^#/, ""))));
    let theirs = new Set([...s.trail, ...s.inline].map(normaliseTag));
    if (structuralOnly) theirs = new Set([...theirs].filter((t) => isStructural(t, districts)));

    for (const t of ours) {
      if (theirs.has(t)) tp++;
      else wrong.set(t, (wrong.get(t) ?? 0) + 1);
    }
    for (const t of theirs) if (!ours.has(t)) missed.set(t, (missed.get(t) ?? 0) + 1);
    got += ours.size;
    want += theirs.size;
    if (ours.size === theirs.size && [...ours].every((t) => theirs.has(t))) exact++;

    const deskBrand = [...theirs].find((t) => BRANDS.has(t));
    if (deskBrand) {
      brandOf++;
      if ([...ours].find((t) => BRANDS.has(t)) === deskBrand) brandOk++;
    }
  }
  const by = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]) as [string, number][];
  return {
    posts: posts.length,
    precision: got ? tp / got : 0,
    recall: want ? tp / want : 0,
    exact: posts.length ? exact / posts.length : 0,
    brand: { ok: brandOk, of: brandOf },
    wrong: by(wrong),
    missed: by(missed),
  };
}

/** Floors for CI. Raise them when a change genuinely improves the score; never lower one quietly. */
export const BASELINE = { precision: 0.85, exact: 0.6, brand: 0.95 };

/** CLI: `tsx test/hashtag-replay.ts corpus.json [more.json ...]` */
if (process.argv[1]?.endsWith("hashtag-replay.ts")) {
  const posts: CorpusPost[] = [];
  for (const f of process.argv.slice(2)) {
    const j = JSON.parse(readFileSync(f, "utf8"));
    posts.push(...(j.tweets ?? j.posts ?? j));
  }
  const book = new PlaceBook(parsePlacesData(JSON.parse(readFileSync(new URL("../../../apps/worker/config/rajasthan-places.json", import.meta.url), "utf8"))));
  const topics = hashtagGazetteer(
    CATEGORY_SEED_RULES.map((r, i) => ({
      id: `seed${i}`, matchType: "entity" as const, name: r.name, aliases: [...r.aliases], hashtagLatin: r.tag,
      hashtagDevanagari: null, priority: r.priority, negativePhrases: [...(r.negativePhrases ?? [])],
    })),
  );
  const show = (label: string, r: Report) =>
    console.log(
      `${label.padEnd(16)} ${String(r.posts).padStart(5)} posts   precision ${(r.precision * 100).toFixed(1)}%   ` +
      `recall ${(r.recall * 100).toFixed(1)}%   exact ${(r.exact * 100).toFixed(1)}%   brand ${(r.brand.ok / (r.brand.of || 1) * 100).toFixed(1)}%`,
    );
  const all = replayHashtags(posts, book, topics);
  show("all posts", all);
  for (const f of ["A", "B", "C"] as const) {
    const sub = posts.filter((p) => postFormat(p.text) === f);
    if (sub.length) show(`format ${f}${f === "A" ? " (ours)" : ""}`, replayHashtags(sub, book, topics));
  }
  console.log("\ntags we put on a post the desk had not written:");
  for (const [t, c] of all.wrong.slice(0, 10)) console.log(`  ${String(c).padStart(4)}  #${t}`);
  console.log("\ntags the desk wrote that we do not produce:");
  for (const [t, c] of all.missed.slice(0, 10)) console.log(`  ${String(c).padStart(4)}  #${t}`);
  const a = replayHashtags(posts.filter((p) => postFormat(p.text) === "A"), book, topics);
  if (a.posts && (a.precision < BASELINE.precision || a.exact < BASELINE.exact)) {
    console.error(`\nFAIL: format A precision ${(a.precision * 100).toFixed(1)}% / exact ${(a.exact * 100).toFixed(1)}% is below the floor`);
    process.exit(1);
  }
}
