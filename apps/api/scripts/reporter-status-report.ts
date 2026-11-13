// The weekly reporter-status report (reporter-prior brief §2.2): which file-name values the reporter list and
// the bureau code table are missing, most frequent first. Read-only.
//
//   node --env-file=.env --import tsx apps/api/scripts/reporter-status-report.ts [--org <id>] [--days 7] [--limit 20] [--json]
//
//   unknown_token        a reporter token no one in reporter-handles.json is listed for (no byline went out)
//   collision            a token two reporters claim (tagged for neither)
//   unknown_bureau_code  a district code the places file does not carry (the story lost its stated district)
//
// --org defaults to ORG_ID. Reads post_decisions only, so it covers breaking drafts composed since migration 0024.

import { parseArgs } from "node:util";
import { createDb, reporterStatusReport, type StatusReportRow } from "@socia/db";

const { values } = parseArgs({
  options: { org: { type: "string" }, days: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } },
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const orgId = values.org ?? process.env.ORG_ID;
if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("--org <uuid> (or ORG_ID) is required");
const days = Number(values.days ?? 7);
const limit = Number(values.limit ?? 20);
if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("--days must be a whole number from 1 to 366");
if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be a whole number from 1 to 200");

// Up to now by the database's clock (no upper bound is passed): proposed_at is stamped by the database
const until = new Date();
const since = new Date(until.getTime() - days * 86_400_000);
const { db, close } = createDb(url, 1);
try {
  const { rows, dropped, coverage } = await reporterStatusReport(db, orgId, { since, limit });
  if (values.json) {
    console.log(JSON.stringify({ since, until, coverage, dropped, rows }, null, 2));
  } else {
    console.log(`Reporter status, ${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)} (${days} days)`);
    // A gap in the log is not a clean week: say how much of the window the log covers
    console.log(`Coverage: ${coverage.logged} of ${coverage.breakingDrafts} breaking drafts have a decision-log row`);
    console.log(`Left out: ${dropped} row(s) of these statuses with no token or code to show\n`);
    for (const status of ["unknown_token", "collision", "unknown_bureau_code"] as const) {
      const list = rows.filter((r: StatusReportRow) => r.status === status);
      console.log(`${status} (${list.length})`);
      if (!list.length) console.log("  none");
      for (const r of list) console.log(`  ${String(r.files).padStart(5)}  ${r.value.padEnd(24)} last ${r.lastSeen.toISOString().slice(0, 16)}  e.g. ${r.example ?? "-"}`);
      console.log("");
    }
  }
} finally {
  await close();
}
