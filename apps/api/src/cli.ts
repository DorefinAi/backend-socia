// Setup commands, run from a Render shell or locally:
//   pnpm --filter @socia/api cli create-org --name "1st India News"
//   pnpm --filter @socia/api cli create-user --org <id> --email a@b.c --name Asha --role admin --password '...'
//       --role: a built-in (admin, editor, operator, viewer) or a custom role of the org
//   pnpm --filter @socia/api cli import-hashtags --org <id> --file rules.csv
//       rules.csv: match_type,name,aliases (| separated),hashtag_latin,hashtag_devanagari,priority
//   pnpm --filter @socia/api cli seed-category-hashtags --org <id>
//       the phase-1 category hashtag rules (#RajasthanPolice, #RoadAccident, ...); adds only rules the org does
//       not have by name, never changes one the desk edited. Safe to run again.
//   pnpm --filter @socia/api cli seed-card-templates --org <id> [--reset-layout]
//       the shared X card designs (assets/card-templates/); safe to run again. Stores the images through
//       STORAGE_DIR (local) or the S3_* settings, like the API. --reset-layout puts back the default layouts.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createDb, hashtagRules, orgs, roles, users, type OrgSettings } from "@socia/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth";
import { seedCategoryHashtags } from "./category-seed";
import { makeStorage } from "./config";
import { seedOrgCardTemplates } from "./org-card-seed";

const DEFAULT_SETTINGS: OrgSettings = {
  hashtagScript: "latin",
  fixedHashtags: [],
  maxHashtags: 4,
  dailyCaps: { x: 800 },
  headlineWords: 9,
};

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    name: { type: "string" }, org: { type: "string" }, email: { type: "string" }, role: { type: "string" },
    password: { type: "string" }, platforms: { type: "string" }, file: { type: "string" }, "reset-layout": { type: "boolean" },
  },
});

function need(key: keyof typeof values): string {
  const v = values[key];
  if (typeof v !== "string" || !v) throw new Error(`--${key} is required`);
  return v;
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, close } = createDb(url, 1);

try {
  if (command === "create-org") {
    const [org] = await db.insert(orgs).values({ name: need("name"), settings: DEFAULT_SETTINGS }).returning();
    console.log(`Created org ${org!.name}. Set ORG_ID=${org!.id} on the workers.`);
  } else if (command === "create-user") {
    const role = need("role");
    const known = await db.select({ key: roles.key }).from(roles).where(eq(roles.orgId, need("org")));
    if (!known.some((r) => r.key === role)) throw new Error(`--role must be one of ${known.map((r) => r.key).join(", ")}`);
    const password = need("password");
    if (password.length < 12) throw new Error("--password must be at least 12 characters");
    const [user] = await db
      .insert(users)
      .values({ orgId: need("org"), name: need("name"), email: need("email").toLowerCase(), role, platforms: (values.platforms ?? "x").split(","), passwordHash: await hashPassword(password) })
      .returning();
    console.log(`Created ${user!.role} ${user!.email}. They set up two-step sign-in at first login.`);
  } else if (command === "import-hashtags") {
    const orgId = need("org");
    const lines = (await readFile(need("file"), "utf8")).split(/\r?\n/).slice(1).filter((l) => l.trim());
    const rows = lines.map((line) => {
      const [matchType, name, aliases, latin, devanagari, priority] = line.split(",").map((c) => c.trim());
      return { orgId, matchType: matchType!, name: name!, aliases: aliases ? aliases.split("|").map((a) => a.trim()) : [], hashtagLatin: latin!, hashtagDevanagari: devanagari || null, priority: Number(priority ?? 0) };
    });
    if (rows.length) await db.insert(hashtagRules).values(rows);
    console.log(`Imported ${rows.length} hashtag rules.`);
  } else if (command === "seed-category-hashtags") {
    const orgId = need("org");
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId));
    if (!org) throw new Error(`No org with id ${orgId}`);
    const { inserted, kept } = await seedCategoryHashtags(db, orgId);
    console.log(`Added ${inserted.length} category hashtag rules${inserted.length ? ` (${inserted.join(", ")})` : ""}; ${kept.length} already there, left as they are.`);
  } else if (command === "seed-card-templates") {
    const orgId = need("org");
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId));
    if (!org) throw new Error(`No org with id ${orgId}`);
    // Only the storage settings are needed here, not the whole API config
    const storage = makeStorage({ storageDir: process.env.STORAGE_DIR ?? null, port: Number(process.env.PORT ?? 4000) });
    const results = await seedOrgCardTemplates(db, storage, orgId, { resetLayout: values["reset-layout"] === true });
    for (const r of results) console.log(`${r.slug}: ${r.outcome} (${r.width}x${r.height}, ${r.key})`);
  } else {
    console.log("Commands: create-org, create-user, import-hashtags, seed-category-hashtags, seed-card-templates");
    process.exitCode = 1;
  }
} finally {
  await close();
}
