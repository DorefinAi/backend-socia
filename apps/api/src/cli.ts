// Setup commands, run from a Render shell or locally:
//   pnpm --filter @socia/api cli create-org --name "1st India News"
//   pnpm --filter @socia/api cli create-user --org <id> --email a@b.c --name Asha --role admin --password '...'
//   pnpm --filter @socia/api cli import-hashtags --org <id> --file rules.csv
//       rules.csv: match_type,name,aliases (| separated),hashtag_latin,hashtag_devanagari,priority

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { USER_ROLES, createDb, hashtagRules, orgs, users, type OrgSettings, type UserRole } from "@socia/db";
import { hashPassword } from "./auth";

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
    password: { type: "string" }, platforms: { type: "string" }, file: { type: "string" },
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
    const role = need("role") as UserRole;
    if (!USER_ROLES.includes(role)) throw new Error(`--role must be one of ${USER_ROLES.join(", ")}`);
    const password = need("password");
    if (password.length < 10) throw new Error("--password must be at least 10 characters");
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
  } else {
    console.log("Commands: create-org, create-user, import-hashtags");
    process.exitCode = 1;
  }
} finally {
  await close();
}
