// Undoes what the tag learning wrongly learned before the learning fix (src/learn-cleanup.ts says what and why):
// polluted desk-handle aliases restored, junk handles retired, typo twins merged, place keywords taken out of learned
// hashtag rules, a handle typed as a hashtag switched off.
//
//   node --env-file=<env> --import tsx packages/db/scripts/learn-cleanup.ts                 DRY RUN: prints the plan, writes nothing
//   node --env-file=<env> --import tsx packages/db/scripts/learn-cleanup.ts --apply         writes it (one transaction)
//   node --import tsx packages/db/scripts/learn-cleanup.ts --from-json <dir>                DRY RUN on exported tables, no database
//
// --from-json reads handle_directory.json, hashtag_rules.json and audit_learning.json (rows as the tables name their
// columns), and the evidence from the post_decisions export in the same folder (decisions*.json or post_decisions.json):
// without it, nothing the old learning added is kept. The dry run against a database reads in a READ ONLY transaction. --apply plans and writes inside one
// transaction (the plan is made from what the transaction reads, so nothing changes under it), with one audit row per
// change (actor "script:learn-cleanup"); any error rolls everything back. It refuses to --apply on a database whose
// name is not in ALLOWED_DATABASES unless --live is given. The data files are the worker's (apps/worker/config), or
// the same *_FILE environment overrides.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlaceBook, PostedLearner, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles } from "@socia/core";
import { sql } from "drizzle-orm";
import { createDb, type Executor } from "../src/client";
import {
  applyLearnCleanup, describeLearnCleanup, evidenceFromDecisions, planLearnCleanup, type CleanupAuditRow, type CleanupEvidenceRow, type CleanupHandleRow, type CleanupRuleRow,
  type CleanupSnapshot, type DecisionExportRow,
} from "../src/learn-cleanup";

/** Databases it may write without --live: disposable copies and test databases only */
export const ALLOWED_DATABASES = ["socia_phase1_e2e", "socia_test"];

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const live = argv.includes("--live");
const fromJsonAt = argv.indexOf("--from-json");
const fromJson = fromJsonAt >= 0 ? argv[fromJsonAt + 1] : undefined;
for (const [i, a] of argv.entries()) {
  if (!["--apply", "--live", "--from-json"].includes(a) && !(fromJsonAt >= 0 && i === fromJsonAt + 1)) fail(`Unknown option ${a}. Use --apply, --live, --from-json <dir>.`);
}
if (fromJsonAt >= 0 && !fromJson) fail("--from-json needs the directory of the exported tables.");
if (fromJson && apply) fail("--from-json is a dry run only: it has no database to write.");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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

/** The audit rows the plan reads: what the learning wrote, an editor's change to a handle, and any editor change to a hashtag rule */
const AUDIT_ACTIONS = ["handle.keywords_learned", "hashtag.rule_learned", "handle.update"];

async function snapshotFrom(tx: Executor): Promise<CleanupSnapshot> {
  const handles = await tx.execute<CleanupHandleRow & Record<string, unknown>>(
    sql`SELECT id, org_id, handle, aliases, source, verified_at, verified_by, entity_type FROM handle_directory WHERE platform = 'x' ORDER BY created_at`,
  );
  const rules = await tx.execute<CleanupRuleRow & Record<string, unknown>>(sql`SELECT id, org_id, name, aliases, hashtag_latin, hashtag_devanagari, priority, active FROM hashtag_rules ORDER BY updated_at`);
  const audit = await tx.execute<CleanupAuditRow & Record<string, unknown>>(sql`
    SELECT org_id, action, entity_type, entity_id, before, after, at FROM audit_log
    WHERE action IN (${sql.join(AUDIT_ACTIONS.map((a) => sql`${a}`), sql`, `)}) OR (entity_type = 'hashtag_rule' AND starts_with(action, 'hashtag_rule.'))
    ORDER BY at, id`);
  // The drafts the learned rows name: their story, and the handles the desk typed on them (item_outcomes desk_added)
  const evidence = await tx.execute<CleanupEvidenceRow & Record<string, unknown>>(sql`
    SELECT d.id::text AS draft_id, s.headline, s.body, s.district, s.town,
      coalesce((
        SELECT array_agg(DISTINCT lower(ltrim(o->>'item', '@')))
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pd.item_outcomes) = 'array' THEN pd.item_outcomes ELSE '[]'::jsonb END) AS o
        WHERE o->>'kind' = 'handle' AND o->>'outcome' = 'desk_added' AND jsonb_typeof(o->'item') = 'string'
      ), '{}') AS typed
    FROM post_drafts d
    JOIN stories s ON s.id = d.story_id
    LEFT JOIN post_decisions pd ON pd.draft_id = d.id
    WHERE d.id::text IN (
      SELECT DISTINCT after->>'draftId' FROM audit_log WHERE action = 'handle.keywords_learned' AND after->>'draftId' IS NOT NULL
    )`);
  return { handles: handles.rows, rules: rules.rows, audit: audit.rows, evidence: evidence.rows };
}

function snapshotFromJson(dir: string): CleanupSnapshot {
  const rows = <T>(name: string): T[] => {
    const v = json(join(dir, name));
    if (!Array.isArray(v)) fail(`${name} is not a JSON array of rows.`);
    return v as T[];
  };
  const decisions = readdirSync(dir).filter((f) => /^(post_)?decisions.*\.json$/i.test(f));
  if (!decisions.length) console.warn(`No post_decisions export (decisions*.json) in ${dir}: nothing the old learning added is kept.`);
  return {
    handles: rows<CleanupHandleRow>("handle_directory.json"), rules: rows<CleanupRuleRow>("hashtag_rules.json"), audit: rows<CleanupAuditRow>("audit_learning.json"),
    evidence: decisions.flatMap((f) => evidenceFromDecisions(rows<DecisionExportRow>(f))),
  };
}

if (fromJson) {
  const plan = planLearnCleanup(snapshotFromJson(fromJson), learner);
  console.log(`learn-cleanup on the exported tables in ${fromJson}: DRY RUN (nothing written).\n`);
  for (const line of describeLearnCleanup(plan)) console.log(line);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is not set.");
const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
if (apply && !ALLOWED_DATABASES.includes(dbName) && !live) {
  fail(`Refusing to --apply on database "${dbName}": it is not one of ${ALLOWED_DATABASES.join(", ")}. Add --live to write it on purpose.`);
}

const { db, close } = createDb(url, 1, { statementTimeoutMs: 0 });
try {
  if (!apply) {
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return planLearnCleanup(await snapshotFrom(tx), learner);
    });
    console.log(`learn-cleanup on ${dbName}: DRY RUN (nothing written). Add --apply to write it.\n`);
    for (const line of describeLearnCleanup(plan)) console.log(line);
  } else {
    const { plan, written } = await db.transaction(async (tx) => {
      // Nobody learns or edits these rows while the plan is made and written; give up rather than queue behind a long lock
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`LOCK TABLE handle_directory, hashtag_rules IN SHARE ROW EXCLUSIVE MODE`);
      const plan = planLearnCleanup(await snapshotFrom(tx), learner);
      return { plan, written: await applyLearnCleanup(tx, plan) };
    });
    console.log(`learn-cleanup on ${dbName}: WRITTEN in one transaction, ${written} audit rows.\n`);
    for (const line of describeLearnCleanup(plan)) console.log(line);
  }
} finally {
  await close();
}
