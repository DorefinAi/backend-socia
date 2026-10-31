// Seeds the phase-1 category hashtag rules (CATEGORY_SEED_RULES) into an org's hashtag_rules. Idempotent and
// additive: a rule is inserted only when the org has no rule of that name (active or not), so a rule the desk
// edited, or switched off, in Settings → Hashtag rules is never touched. Used by `cli seed-category-hashtags`
// and local-dev socia-setup.

import { CATEGORY_SEED_RULES } from "@socia/core";
import { hashtagRules, type Db } from "@socia/db";
import { and, eq, inArray } from "drizzle-orm";

export interface CategorySeedResult {
  inserted: string[];
  kept: string[];
}

export async function seedCategoryHashtags(db: Db, orgId: string): Promise<CategorySeedResult> {
  const names = CATEGORY_SEED_RULES.map((r) => r.name);
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ name: hashtagRules.name })
      .from(hashtagRules)
      .where(and(eq(hashtagRules.orgId, orgId), inArray(hashtagRules.name, names)));
    const have = new Set(existing.map((r) => r.name));
    const missing = CATEGORY_SEED_RULES.filter((r) => !have.has(r.name));
    if (missing.length) {
      await tx.insert(hashtagRules).values(
        missing.map((r) => ({
          orgId,
          matchType: "entity",
          name: r.name,
          aliases: [...r.aliases],
          hashtagLatin: r.tag,
          hashtagDevanagari: null,
          priority: r.priority,
          negativePhrases: [...(r.negativePhrases ?? [])],
        })),
      );
    }
    return { inserted: missing.map((r) => r.name), kept: [...have] };
  });
}
