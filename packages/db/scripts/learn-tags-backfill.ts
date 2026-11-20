// Applies the tag learning (core learn.ts, src/learn.ts) once to the posts already published: every live published
// post of a breaking draft, oldest first, exactly as if it had been posted now. Desk handles on those posts learn the
// names in their stories; hashtags the desk typed become topic rules (or are saved inactive when nothing names them).
// Safe to run again: what is already learned changes nothing.
//
//   node --env-file=<env> --import tsx packages/db/scripts/learn-tags-backfill.ts --dry-run   (plans only)
//   node --env-file=<env> --import tsx packages/db/scripts/learn-tags-backfill.ts             (writes)
//
// It refuses to run on a database whose name is not in ALLOWED_DATABASES unless --live is given: the live database
// is written only on purpose. Everything runs in one transaction, rolled back for --dry-run (the plan is exactly
// what a real run would write) and on any error. Every change is audited as actor "script:learn-tags-backfill".
// The data files are the worker's (apps/worker/config), or the same *_FILE environment overrides.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PlaceBook, PostedLearner, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles } from "@socia/core";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { createDb } from "../src/client";
import { learnFromPost, type LearnedReport } from "../src/learn";
import { orgs, postDrafts, publishedPosts } from "../src/schema";

/** Databases it may write without --live: disposable copies and test databases only */
export const ALLOWED_DATABASES = ["socia_phase1_e2e", "socia_test"];
const ACTOR = "script:learn-tags-backfill";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const live = args.has("--live");
for (const a of args) if (!["--dry-run", "--live"].includes(a)) fail(`Unknown option ${a}. Use --dry-run and/or --live.`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is not set.");
const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
if (!ALLOWED_DATABASES.includes(dbName) && !live) {
  fail(`Refusing to run on database "${dbName}": it is not one of ${ALLOWED_DATABASES.join(", ")}. Add --live to run on it on purpose.`);
}

const config = (name: string, env?: string) => (env && process.env[env]) || fileURLToPath(new URL(`../../../apps/worker/config/${name}`, import.meta.url));
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const subjects = parseSubjectHandles(json(config("subject-handles.json", "SUBJECT_HANDLES_FILE")));
const learner = new PostedLearner({
  book: new PlaceBook(parsePlacesData(json(config("rajasthan-places.json", "PLACES_FILE")))),
  subjects,
  fileHandles: [
    ...(parseHandleRules(json(config("district-handles.json", "DISTRICT_HANDLES_FILE"))).all ?? []),
    ...(subjects.handles ?? []),
    ...(parsePartyHandles(json(config("party-handles.json", "PARTY_HANDLES_FILE"))).handles ?? []),
    ...(parseReporterHandles(json(config("reporter-handles.json", "REPORTER_HANDLES_FILE"))).handles ?? []),
  ],
});

class DryRun extends Error {}

const { db, close } = createDb(url, 1, { statementTimeoutMs: 0 });
const reports: LearnedReport[] = [];
let posts = 0;
try {
  await db
    .transaction(async (tx) => {
      for (const org of await tx.select({ id: orgs.id }).from(orgs)) {
        const rows = await tx
          .selectDistinctOn([publishedPosts.draftId], {
            id: postDrafts.id, orgId: postDrafts.orgId, storyId: postDrafts.storyId, handlePick: postDrafts.handlePick, hashtags: postDrafts.hashtags,
            hashtagSuggestions: postDrafts.hashtagSuggestions, mentions: postDrafts.mentions, at: publishedPosts.publishedAt,
          })
          .from(publishedPosts)
          .innerJoin(postDrafts, eq(postDrafts.id, publishedPosts.draftId))
          .where(and(eq(publishedPosts.orgId, org.id), isNull(publishedPosts.recalledAt), isNotNull(postDrafts.handlePick)))
          .orderBy(publishedPosts.draftId, asc(publishedPosts.publishedAt));
        rows.sort((a, b) => a.at.getTime() - b.at.getTime());
        for (const draft of rows) {
          posts++;
          const r = await learnFromPost(tx, { orgId: org.id, actorId: null, actor: ACTOR }, draft, learner);
          if (r) reports.push(r);
        }
      }
      if (dryRun) throw new DryRun();
    })
    .catch((err) => {
      if (!(err instanceof DryRun)) throw err;
    });
} finally {
  await close();
}

// ─── What it did (or would do) ───────────────────────────────────────────────
const handles = new Map<string, { added: Set<string>; keywords: number; withheld: string | null; posts: number }>();
for (const r of reports) {
  for (const h of r.handles) {
    const cur = handles.get(h.handle.toLowerCase()) ?? { added: new Set<string>(), keywords: 0, withheld: h.withheld, posts: 0 };
    h.added.forEach((k) => cur.added.add(k));
    cur.keywords = Math.max(cur.keywords, h.keywords);
    cur.posts++;
    handles.set(h.handle.toLowerCase(), { ...cur, withheld: h.withheld });
  }
}
const tags = new Map<string, { tag: string; actions: Set<string>; active: boolean; keywords: string[] }>();
for (const r of reports) {
  for (const t of r.tags) {
    const cur = tags.get(t.tag.toLowerCase()) ?? { tag: t.tag, actions: new Set<string>(), active: false, keywords: [] };
    cur.actions.add(t.action);
    cur.active = t.active;
    if (t.keywords.length) cur.keywords = t.keywords;
    tags.set(t.tag.toLowerCase(), cur);
  }
}

const mode = dryRun ? "DRY RUN (nothing written)" : "WRITTEN";
console.log(`learn-tags backfill on ${dbName}: ${mode}. ${posts} published breaking posts read.`);
const learned = [...handles.entries()].filter(([, h]) => h.added.size);
const withheld = [...handles.entries()].filter(([, h]) => h.withheld);
const nothing = [...handles.entries()].filter(([, h]) => !h.withheld && !h.added.size);
console.log(`\nDesk handles on posts: ${handles.size}. Learned keywords: ${learned.length}. Withheld: ${withheld.length}. Nothing new to learn: ${nothing.length}.`);
for (const [h, v] of learned) console.log(`  + ${h} (${v.posts} post${v.posts === 1 ? "" : "s"}): ${[...v.added].join(", ")}`);
for (const [h, v] of withheld) console.log(`  - ${h}: withheld (${v.withheld})`);
for (const [h, v] of nothing) console.log(`  · ${h}: nothing new (${v.keywords} keyword${v.keywords === 1 ? "" : "s"} already)`);

const by = (a: string) => [...tags.values()].filter((t) => t.actions.has(a));
const created = by("created");
console.log(`\nTyped hashtags: ${tags.size}. Rules created: ${created.filter((t) => t.active).length} active, ${created.filter((t) => !t.active).length} inactive. Already learned, unchanged: ${[...tags.values()].filter((t) => t.actions.size === 1 && t.actions.has("unchanged")).length}. Duplicates of an existing rule: ${by("duplicate").length}. Footer tags: ${by("footer").length}.`);
for (const t of created.filter((x) => x.active)) console.log(`  + ${t.tag}: ${t.keywords.join(", ")}`);
for (const t of [...tags.values()].filter((x) => !x.active && (x.actions.has("created") || x.actions.has("updated")))) console.log(`  ○ ${t.tag}: saved INACTIVE (no usable keyword)`);
for (const t of by("duplicate")) console.log(`  = ${t.tag}: an editor's rule already has this tag (left alone)`);
for (const t of by("footer")) console.log(`  × ${t.tag}: footer tag (never a rule)`);
