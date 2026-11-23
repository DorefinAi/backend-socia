// The heading golden set (SOCIA_HEADING_GAPS_AND_PLAN step 6): every breaking story the desk posted through Socia, with
// its FTP file and the text that went out, for heading-replay.ts. READ ONLY: one read-only transaction, rolled back.
//
//   node --env-file=.env --import tsx packages/db/scripts/export-golden.ts <out.json> [from YYYY-MM-DD]
//   node --import tsx packages/db/scripts/heading-replay.ts <out.json> <replay.json>
//
// The output holds the newsroom's story text: keep it out of the repository (a scratch folder).

import { writeFileSync } from "node:fs";
import pg from "pg";

const [out, from] = process.argv.slice(2);
if (!out || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from))) {
  console.error("usage: export-golden.ts <out.json> [from YYYY-MM-DD, IST]");
  process.exit(2);
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query("BEGIN READ ONLY");
  const { rows } = await db.query(
    `select f.file_name, s.source_text, s.created_at, s.district, s.district_from, s.town, d.body_text as draft_body, d.compose_version,
            p.text as posted, p.published_at
       from published_posts p
       join post_drafts d on d.id = p.draft_id
       join stories s on s.id = d.story_id
       join ingested_files f on f.id = s.file_id
      where p.recalled_at is null and s.layout = 'breaking' and s.source_text is not null
        and ($1::date is null or (p.published_at at time zone 'Asia/Kolkata')::date >= $1::date)
      order by p.published_at`,
    [from ?? null],
  );
  writeFileSync(out, JSON.stringify(rows));
  console.log(`${rows.length} posted stories → ${out}`);
} finally {
  await db.query("ROLLBACK").catch(() => undefined);
  await db.end();
}
