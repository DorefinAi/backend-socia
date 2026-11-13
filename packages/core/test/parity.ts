// Live-vs-reference PARITY (fix prompt FL_V_N_M_D_C, "Done when" 3): the live drafting path and the replay
// reference must emit IDENTICAL hashtags and handles on every replay day. Measurement only: nothing here
// changes a composer, and both composers are imported as they are on the branch it runs on.
//
//   live       parseBreaking(<.txt>, "", book) → composeBreaking(...)       what the desk's queue gets
//   reference  composePostTags(<post text>, replayContext())                what day-replay.ts scores
//
// EMITTED, per path (what goes on the post by itself; suggestions are never compared):
//   live       lead  = the hashtags before the headline in the draft's line 1 (segmentPost on bodyText)
//              trail = draft.hashtags (the footer)                handles = draft.mentions
//   reference  lead  = PostTags.lead                trail = PostTags.trail     handles = none (it has no handle logic)
// Tags are compared as sets per slot after NFC and the shared normaliser (hashtag-normalise.json). A post is a
// MATCH when lead and trail sets are equal. Handles are compared only where BOTH paths produce some; the reference
// produces none today, so the handle line reports how many live handles have nothing to be compared against.
//
// THE EQUIVALENT INPUT (assumptions; see postToTxt):
//   1. A published post is turned back into the .txt the desk would have filed: links out; every tag-only line
//      after line 1 (the trailing "#Dungarpur #RajasthanWithFirstIndia @CP_Jodhpur" run) out; a run of hashtags
//      and handles at the END of the last body line out (the same run, typed on the line above). Line 1 is kept
//      WHOLE, its leading tag run included: "#Jaipur #सांगानेर: <headline>" is how the desk writes the place on a
//      headline line, and parseBreaking reads it as headline_prefix (explicit), as it would in a filed .txt.
//   2. There is no file name: "" is passed, so no district code, no reporter, no reporter desk rule, no NWS flag.
//      The reference gets no reporterPolicy either, so the two sides agree on that.
//   3. Inline hashtags and handles inside the copy stay: they are the copy as written.
//   4. A video post's "<title> | Rajasthan News" label stays in the headline: the live path sees it as written.
//   5. `at` is the post's own timestamp when the export has one (campaign windows only touch suggestions).
//   6. The org's topic rules (database) are not loaded: they only ever produce suggestions in composeBreaking.
//
// TWO REFERENCE RUNS separate a real divergence from an input-shape artefact:
//   ref(published)  composePostTags on the post as published: the number the "Done when" item is about
//   ref(txt)        composePostTags on the reconstructed .txt (assumption 1), i.e. the SAME information the live
//                   path got. A difference here is a real logic divergence between the two composers. A difference
//                   only in ref(published) comes from what the stripped trailing run told the reference (a
//                   format-C district, a brand the desk chose) — an input-shape artefact.
//
// OUTPUT per day: identical (lead and trail sets equal), same set (slots ignored), lead / trail agreement, the
// per-post split (differs from both references = real; from ref(published) only = input-shape artefact; from
// ref(txt) only = real but hidden by the desk's trailing run), the handle line, cause counts per format (A/B/C as
// composePostTags tells them) and the first PARITY_EXAMPLES (default 10) differences per reference, by cause.
// Exit 1 when any post differs from ref(published). The vitest gate is parity.test.ts.
//
// INPUT: REPLAY_DAYS="sep09=C:\a.json,nov12=C:\b.json" (any labels), else the six days day-replay.ts knows.
// Exports are untrusted data, read only: only `text` (or `body`, as in the nov12 export) and a timestamp are read.
//
// CLI: npx tsx test/parity.ts                 (per-day table + first differences per day, grouped by cause)
//      PARITY_EXAMPLES=20 npx tsx test/parity.ts

import { existsSync, readFileSync } from "node:fs";
import {
  LEADER_POST, PlaceBook, composeBreaking, composePostTags, normaliseTag, parseBeatHandles, parseBreaking, parseHandleRules, parseHashtagNormalise,
  parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules, segmentPost, stripLinks,
  type BreakingDraft, type PostTagContext, type PostTags, type TagNormaliser,
} from "../src";
import { dayExports, replayContext } from "./day-replay";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));

// ─── the live path's data, as the worker loads it ────────────────────────────

export interface LiveEnv {
  book: PlaceBook;
  rules: ReturnType<typeof parseHandleRules>;
  opts: Parameters<typeof composeBreaking>[3];
  normaliser: TagNormaliser;
}

export function liveEnv(): LiveEnv {
  const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
  const rules = parseHandleRules(cfg("district-handles.json"));
  const subjects = parseSubjectHandles(cfg("subject-handles.json"));
  const reporters = parseReporterHandles(cfg("reporter-handles.json"));
  const parties = parsePartyHandles(cfg("party-handles.json"));
  const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
  const beats = parseBeatHandles(cfg("beat-handles.json"), directory);
  const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag));
  const suggestRules = parseSuggestRules(cfg("campaigns.json"));
  return { book, rules, normaliser, opts: { subjects, reporters, parties, beats, normaliser, suggestRules } };
}

// ─── the equivalent input ────────────────────────────────────────────────────

const TAG = String.raw`[#@][\wऀ-ॣ०-ॿÀ-ɏ]+`;
const TAG_ONLY_LINE = new RegExp(String.raw`^(?:${TAG}[\s,.]*)+$`, "u");
const TRAILING_RUN = new RegExp(String.raw`(?:\s+${TAG}[\s,.]*)+$`, "u");

/** The .txt the desk would have filed for a published post (assumption 1 above) */
export function postToTxt(published: string): string {
  const lines = stripLinks(published).normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const [first = "", ...rest] = lines;
  const body = rest.filter((l) => l && !TAG_ONLY_LINE.test(l));
  if (body.length) body[body.length - 1] = body[body.length - 1]!.replace(TRAILING_RUN, "").trim();
  else if (!TAG_ONLY_LINE.test(first)) return first.replace(TRAILING_RUN, "").trim();
  return [first, ...body].filter(Boolean).join("\n");
}

// ─── the two paths ───────────────────────────────────────────────────────────

export interface Emitted {
  lead: string[];
  trail: string[];
  handles: string[];
}

export function runLive(txt: string, env: LiveEnv, at?: Date): { emitted: Emitted; draft: BreakingDraft } {
  const p = parseBreaking(txt, "", env.book);
  const draft = composeBreaking(
    {
      headline: p.headline, points: p.points, district: p.district, districtFrom: p.districtFrom, town: p.town, rajasthan: p.rajasthan,
      leaderPost: LEADER_POST.test(p.headline), rawHeadline: p.rawHeadline, reporterToken: null, fileDistrict: null, unknownBureauCode: null,
    },
    env.rules, env.book, { ...env.opts, ...(at && { at }) },
  );
  const line1 = draft.bodyText.split("\n")[0] ?? "";
  return { emitted: { lead: segmentPost(line1).lead, trail: draft.hashtags.map((t) => t.replace(/^#/, "")), handles: draft.mentions.map((h) => h.replace(/^@/, "")) }, draft };
}

export function runReference(text: string, ctx: PostTagContext): { emitted: Emitted; tags: PostTags } {
  const tags = composePostTags(text, ctx);
  return { emitted: { lead: tags.lead, trail: tags.trail, handles: [] }, tags };
}

// ─── comparison and causes ───────────────────────────────────────────────────

export interface Diff {
  /** Cause keys, coarse enough to group by ("lead district: live only") */
  causes: string[];
  /** The same with the tags, for the examples */
  detail: string[];
}

const BRANDS = new Set(["RajasthanWithFirstIndia", "FirstIndiaNews"]);
const DEVA = /[ऀ-ॿ]/u;

export function compareEmitted(live: Emitted, ref: Emitted, normaliser: TagNormaliser): Diff | null {
  const n = (t: string) => normaliseTag(t.normalize("NFC"), normaliser).tag;
  const causes: string[] = [];
  const detail: string[] = [];
  const add = (cause: string, d: string) => {
    if (!causes.includes(cause)) causes.push(cause);
    detail.push(d);
  };
  let ll = live.lead.map(n);
  const rl = ref.lead.map(n);
  const lt = new Set(live.trail.map(n));
  const rt = new Set(ref.trail.map(n));
  // The same place in another slot: the live path leads with it ("#Jodhpur: ..."), the reference copies the desk's
  // trailing run ("...\n#Jodhpur #RajasthanWithFirstIndia", format C). Counted once, then taken out of both sides.
  for (const t of ll.filter((x) => !rl.includes(x) && rt.has(x) && !lt.has(x))) {
    add("slot: live leads with the place, ref has it in the trailing run", `slot #${t} live lead / ref trail`);
    ll = ll.filter((x) => x !== t);
    rt.delete(t);
  }
  // Lead: the district slot (a Latin tag) and the town slot (a Devanagari tag), then anything else
  const slot = (xs: string[], deva: boolean) => xs.filter((t) => DEVA.test(t) === deva);
  for (const [name, deva] of [["district", false], ["town", true]] as const) {
    const a = new Set(slot(ll, deva));
    const b = new Set(slot(rl, deva));
    const onlyLive = [...a].filter((t) => !b.has(t));
    const onlyRef = [...b].filter((t) => !a.has(t));
    if (!onlyLive.length && !onlyRef.length) continue;
    const kind = onlyLive.length && onlyRef.length ? "different" : onlyLive.length ? "live only" : "ref only";
    const folded = onlyLive.length === onlyRef.length && onlyLive.every((t, i) => t.toLowerCase() === onlyRef[i]!.toLowerCase());
    add(`lead ${name}: ${folded ? "case only" : kind}`, `lead ${name} live[${onlyLive.map((t) => `#${t}`).join(" ")}] ref[${onlyRef.map((t) => `#${t}`).join(" ")}]`);
  }
  // Trail: the brand, #FINVideo, a place (format C) and anything else
  const lb = [...lt].filter((t) => BRANDS.has(t));
  const rb = [...rt].filter((t) => BRANDS.has(t));
  if (lb.join() !== rb.join()) add(`brand: live ${lb.join("+") || "none"} / ref ${rb.join("+") || "none"}`, `brand live[${lb.join(" ")}] ref[${rb.join(" ")}]`);
  for (const t of rt) {
    if (BRANDS.has(t) || lt.has(t)) continue;
    add(t === "FINVideo" ? "trail #FINVideo: ref only (video post)" : "trail tag: ref only (district/place in the trailing run)", `trail ref-only #${t}`);
  }
  for (const t of lt) if (!BRANDS.has(t) && !rt.has(t)) add("trail tag: live only", `trail live-only #${t}`);
  return causes.length ? { causes, detail } : null;
}

/** Whether both paths emit the same hashtags, slots ignored */
export function sameSet(live: Emitted, ref: Emitted, normaliser: TagNormaliser): boolean {
  const all = (e: Emitted) => new Set([...e.lead, ...e.trail].map((t) => normaliseTag(t.normalize("NFC"), normaliser).tag));
  const a = all(live);
  const b = all(ref);
  return a.size === b.size && [...a].every((t) => b.has(t));
}

// ─── one day ─────────────────────────────────────────────────────────────────

export interface ExportPost {
  text: string;
  at?: Date;
}

/** The posts of one export: `text`, or `body` (nov12), and a timestamp when there is one. Untrusted, read only. */
export function readPosts(path: string): ExportPost[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const root = j as { tweets?: unknown; posts?: unknown };
  const list = Array.isArray(j) ? j : (root.tweets ?? root.posts);
  if (!Array.isArray(list)) throw new Error(`${path}: expected { "tweets": [...] }`);
  const out: ExportPost[] = [];
  for (const raw of list) {
    const t = raw as Record<string, unknown> | null;
    const text = typeof t?.text === "string" ? t.text : typeof t?.body === "string" ? t.body : null;
    if (text === null) continue;
    const ts = typeof t?.timestamp_utc === "string" ? t.timestamp_utc : typeof t?.time_utc === "string" ? t.time_utc : null;
    const at = ts ? new Date(ts) : null;
    out.push(at && !Number.isNaN(at.getTime()) ? { text, at } : { text });
  }
  return out;
}

export interface Example {
  index: number;
  format: string;
  headline: string;
  detail: string[];
  causes: string[];
}

export interface Side {
  /** Posts whose lead and trail sets are identical to the live path's */
  match: number;
  /** Same set of emitted hashtags, whatever slot each is in */
  setMatch: number;
  leadMatch: number;
  trailMatch: number;
  causes: Map<string, number>;
  examples: Example[];
}

export interface DayParity {
  label: string;
  posts: number;
  published: Side;
  txt: Side;
  /** Per post: differs from both references (a real divergence), from ref(published) only (input-shape artefact), from ref(txt) only (a real divergence the desk's trailing run hid) */
  split: { both: number; publishedOnly: number; txtOnly: number };
  /** Posts where both sides produced handles (comparable), and the live handles with nothing to compare against */
  handlesComparable: number;
  handlesSame: number;
  liveHandlePosts: number;
  liveHandles: number;
}

const newSide = (): Side => ({ match: 0, setMatch: 0, leadMatch: 0, trailMatch: 0, causes: new Map(), examples: [] });

export function parityDay(label: string, posts: readonly ExportPost[], env: LiveEnv = liveEnv(), ctx: PostTagContext = replayContext(), maxExamples = 10): DayParity {
  const r: DayParity = { label, posts: posts.length, published: newSide(), txt: newSide(), split: { both: 0, publishedOnly: 0, txtOnly: 0 }, handlesComparable: 0, handlesSame: 0, liveHandlePosts: 0, liveHandles: 0 };
  posts.forEach((post, index) => {
    const txt = postToTxt(post.text);
    const live = runLive(txt, env, post.at).emitted;
    if (live.handles.length) {
      r.liveHandlePosts++;
      r.liveHandles += live.handles.length;
    }
    const differs: boolean[] = [];
    for (const [side, input] of [[r.published, post.text], [r.txt, txt]] as const) {
      const ref = runReference(input, ctx);
      if (side === r.published && ref.emitted.handles.length && live.handles.length) {
        r.handlesComparable++;
        const a = new Set(live.handles.map((h) => h.toLowerCase()));
        if (ref.emitted.handles.length === a.size && ref.emitted.handles.every((h) => a.has(h.toLowerCase()))) r.handlesSame++;
      }
      const d = compareEmitted(live, ref.emitted, env.normaliser);
      differs.push(!!d);
      if (sameSet(live, ref.emitted, env.normaliser)) side.setMatch++;
      if (!d) {
        side.match++;
        side.leadMatch++;
        side.trailMatch++;
        continue;
      }
      if (!d.causes.some((c) => c.startsWith("lead") || c.startsWith("slot"))) side.leadMatch++;
      if (!d.causes.some((c) => c.startsWith("brand") || c.startsWith("trail") || c.startsWith("slot"))) side.trailMatch++;
      for (const c of d.causes) side.causes.set(`[${ref.tags.format}] ${c}`, (side.causes.get(`[${ref.tags.format}] ${c}`) ?? 0) + 1);
      if (side.examples.length < maxExamples) {
        side.examples.push({ index, format: ref.tags.format, headline: (stripLinks(post.text).split("\n")[0] ?? "").trim().slice(0, 90), detail: d.detail, causes: d.causes });
      }
    }
    if (differs[0] && differs[1]) r.split.both++;
    else if (differs[0]) r.split.publishedOnly++;
    else if (differs[1]) r.split.txtOnly++;
  });
  return r;
}

/** The days to run: REPLAY_DAYS (any label), else the six day-replay.ts knows, each with whether its export is there */
export function parityDays(env = process.env): { label: string; path: string; present: boolean }[] {
  if (env.REPLAY_DAYS?.trim()) {
    return env.REPLAY_DAYS.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf("=");
      const path = p.slice(i + 1).trim();
      return { label: p.slice(0, i).trim(), path, present: existsSync(path) };
    });
  }
  return dayExports(env).map((d) => ({ label: d.day, path: d.path, present: d.present }));
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");

export function printDay(r: DayParity, examples: boolean): void {
  const line = (name: string, s: Side) =>
    `   ${name.padEnd(15)} identical ${String(s.match).padStart(4)}/${r.posts} (${pct(s.match, r.posts).padStart(6)})   same set ${pct(s.setMatch, r.posts).padStart(6)}   lead ${pct(s.leadMatch, r.posts).padStart(6)}   trail ${pct(s.trailMatch, r.posts).padStart(6)}`;
  console.log(`\n${r.label}  ${r.posts} posts`);
  console.log(line("ref(published)", r.published));
  console.log(line("ref(txt)", r.txt));
  console.log(`   differing posts: ${r.split.both} vs both references (real), ${r.split.publishedOnly} vs ref(published) only (input-shape artefact), ${r.split.txtOnly} vs ref(txt) only (real, hidden by the desk's trailing run)`);
  console.log(`   handles: comparable on ${r.handlesComparable} posts (${r.handlesSame} same); live emitted ${r.liveHandles} handles on ${r.liveHandlePosts} posts, the reference emits none`);
  for (const [name, s] of [["ref(published)", r.published], ["ref(txt)", r.txt]] as const) {
    if (!s.causes.size) continue;
    console.log(`   causes vs ${name}:`);
    for (const [c, k] of [...s.causes].sort((a, b) => b[1] - a[1])) console.log(`      ${String(k).padStart(4)}  ${c}`);
    if (!examples) continue;
    // The first differences, grouped by their first cause
    const groups = new Map<string, Example[]>();
    for (const e of s.examples) groups.set(e.causes[0]!, [...(groups.get(e.causes[0]!) ?? []), e]);
    console.log(`   first ${s.examples.length} differences vs ${name}, by cause:`);
    for (const [c, es] of groups) {
      console.log(`      ${c}`);
      for (const e of es) console.log(`         #${e.index} [${e.format}] ${e.detail.join("; ")}  | ${e.headline}`);
    }
  }
}

if (process.argv[1]?.endsWith("parity.ts")) {
  const env = liveEnv();
  const ctx = replayContext();
  const max = Number(process.env.PARITY_EXAMPLES ?? 10);
  const totals = { posts: 0, pub: 0, txt: 0 };
  for (const { label, path, present } of parityDays()) {
    if (!present) {
      console.log(`\n${label}  SKIPPED: no export at ${path}`);
      continue;
    }
    const r = parityDay(label, readPosts(path), env, ctx, max);
    totals.posts += r.posts;
    totals.pub += r.published.match;
    totals.txt += r.txt.match;
    printDay(r, true);
  }
  console.log(`\nALL DAYS  ${totals.posts} posts   identical vs ref(published) ${totals.pub} (${pct(totals.pub, totals.posts)})   vs ref(txt) ${totals.txt} (${pct(totals.txt, totals.posts)})`);
  // Done-when 3 asks for identical on every day: exit 1 when any post differs from the published reference
  process.exit(totals.pub === totals.posts ? 0 : 1);
}
