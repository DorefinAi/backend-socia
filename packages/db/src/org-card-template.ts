// The org's shared card designs (contract: dev-docs/org-card-templates-contract.md). Everyone in the org
// reads them; desk users upload more (v2); the uploader or an admin renames them and moves their areas; only
// an admin sets the default tags or deletes one; the CLI seeds the house designs. Every query is keyed on the org id
// the caller passes from the session (or the CLI's --org), never on a row id from a client.
//
// Storage: an image's key carries a hash of its bytes, so seeding the same file again writes the same key
// and changes nothing; a new file gets a new key, and the replaced one is removed after commit.

import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Db, Executor } from "./client";
import type { Actor } from "./desk";
import { orgCardTemplates, users, type OrgCardLayout, type OrgTemplateDefaultFor } from "./schema";

export type OrgCardTemplate = typeof orgCardTemplates.$inferSelect;
/** A template with its uploader's current name (null for seeded templates or a deleted uploader) */
export type OrgCardTemplateRow = OrgCardTemplate & { createdByName: string | null };

const one = (orgId: string, platform: string, slug: string) =>
  and(eq(orgCardTemplates.orgId, orgId), eq(orgCardTemplates.platform, platform), eq(orgCardTemplates.slug, slug));

/** One writer per org template at a time, even before its row exists (two seeds at once). */
async function lockOne(tx: Executor, orgId: string, platform: string, slug: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`org_card_template:${orgId}:${platform}:${slug}`}, 0))`);
}

/**
 * One writer of the org's default tags (and of the next sort number) at a time. Always taken BEFORE lockOne
 * when both are needed, so two writers cannot wait on each other.
 */
async function lockOrg(tx: Executor, orgId: string, platform: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`org_card_templates:${orgId}:${platform}`}, 0))`);
}

/** The uploader's name, if any; the users join is on the same org so a stray id never shows a name. */
const withCreator = (ex: Executor) =>
  ex
    .select({ t: orgCardTemplates, createdByName: users.name })
    .from(orgCardTemplates)
    .leftJoin(users, and(eq(users.id, orgCardTemplates.createdBy), eq(users.orgId, orgCardTemplates.orgId)));

const flat = (r: { t: OrgCardTemplate; createdByName: string | null }): OrgCardTemplateRow => ({ ...r.t, createdByName: r.createdByName });

/** The org's templates on a platform, in their display order. */
export async function listOrgCardTemplates(db: Db, orgId: string, platform: string): Promise<OrgCardTemplateRow[]> {
  const rows = await withCreator(db)
    .where(and(eq(orgCardTemplates.orgId, orgId), eq(orgCardTemplates.platform, platform)))
    .orderBy(asc(orgCardTemplates.sort), asc(orgCardTemplates.slug));
  return rows.map(flat);
}

/** Null when the org has no template with this slug (including a slug only another org has). */
export async function getOrgCardTemplate(db: Db, orgId: string, platform: string, slug: string): Promise<OrgCardTemplateRow | null> {
  const [row] = await withCreator(db).where(one(orgId, platform, slug));
  return row ? flat(row) : null;
}

/** Removes `tags` from every other template of the org/platform (one default per tag). Under lockOrg. */
async function takeDefaults(tx: Executor, orgId: string, platform: string, exceptId: string, tags: readonly OrgTemplateDefaultFor[]) {
  if (!tags.length) return [];
  const tagArray = sql`ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`;
  const others = await tx
    .select({ id: orgCardTemplates.id, slug: orgCardTemplates.slug, defaultFor: orgCardTemplates.defaultFor })
    .from(orgCardTemplates)
    .where(and(eq(orgCardTemplates.orgId, orgId), eq(orgCardTemplates.platform, platform), ne(orgCardTemplates.id, exceptId), sql`${orgCardTemplates.defaultFor} && ${tagArray}`));
  const out: { slug: string; before: OrgTemplateDefaultFor[]; after: OrgTemplateDefaultFor[] }[] = [];
  for (const o of others) {
    const after = o.defaultFor.filter((t) => !tags.includes(t));
    await tx.update(orgCardTemplates).set({ defaultFor: after, updatedAt: sql`now()` }).where(eq(orgCardTemplates.id, o.id));
    out.push({ slug: o.slug, before: o.defaultFor, after });
  }
  return out;
}

export interface NewOrgCardTemplate {
  platform: string;
  /** Carries a random suffix; a clash returns null so the caller can pick another */
  slug: string;
  label: string;
  backgroundKey: string;
  width: number;
  height: number;
  layout: OrgCardLayout;
}

/**
 * An uploaded template: no default tags, last in the order, owned by the uploader. Audited. Null when the
 * slug is already taken in the org (the caller retries with another suffix).
 */
export async function createOrgCardTemplate(db: Db, actor: Actor, t: NewOrgCardTemplate): Promise<OrgCardTemplateRow | null> {
  return db.transaction(async (tx) => {
    await lockOrg(tx, actor.orgId, t.platform);
    const [last] = await tx
      .select({ sort: sql<number | null>`max(${orgCardTemplates.sort})` })
      .from(orgCardTemplates)
      .where(and(eq(orgCardTemplates.orgId, actor.orgId), eq(orgCardTemplates.platform, t.platform)));
    const sort = last?.sort == null ? 0 : Number(last.sort) + 1;
    const [row] = await tx
      .insert(orgCardTemplates)
      .values({ orgId: actor.orgId, ...t, defaultFor: [], sort, createdBy: actor.id })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    await audit(tx, {
      orgId: actor.orgId, actorId: actor.id, action: "org_card_template.created", entityType: "org_card_template", entityId: row.id,
      before: null,
      after: { platform: row.platform, slug: row.slug, label: row.label, backgroundKey: row.backgroundKey, width: row.width, height: row.height, sort },
    });
    return { ...row, createdByName: actor.name };
  });
}

export interface OrgCardTemplateChange {
  label?: string;
  layout?: OrgCardLayout;
  defaultFor?: OrgTemplateDefaultFor[];
}

/**
 * Renames, moves the areas and/or sets the default tags, in one transaction. `authorize` sees the row as it is
 * under the lock (with its uploader) and throws to refuse. Setting a tag here removes it from every other
 * template of the org. Null when the actor's org has no such template. Each kind of change is audited.
 */
export async function changeOrgCardTemplate(
  db: Db, actor: Actor, platform: string, slug: string, change: OrgCardTemplateChange, authorize: (before: OrgCardTemplate) => void,
): Promise<OrgCardTemplateRow | null> {
  return db.transaction(async (tx) => {
    if (change.defaultFor) await lockOrg(tx, actor.orgId, platform);
    await lockOne(tx, actor.orgId, platform, slug);
    const [before] = await tx.select().from(orgCardTemplates).where(one(actor.orgId, platform, slug));
    if (!before) return null;
    authorize(before);
    const entry = (action: string, b: unknown, a: unknown) =>
      audit(tx, { orgId: actor.orgId, actorId: actor.id, action, entityType: "org_card_template", entityId: before.id, before: b, after: a });

    const set: Partial<typeof orgCardTemplates.$inferInsert> = {};
    if (change.label !== undefined && change.label !== before.label) {
      set.label = change.label;
      await entry("org_card_template.renamed", { label: before.label }, { label: change.label });
    }
    // Structural: jsonb hands keys back in its own order
    if (change.layout !== undefined && !isDeepStrictEqual(change.layout, before.layout)) {
      set.layout = change.layout;
      await entry("org_card_template.layout_changed", before.layout, change.layout);
    }
    if (change.defaultFor !== undefined) {
      const wanted = [...new Set(change.defaultFor)].sort();
      const removedFrom = await takeDefaults(tx, actor.orgId, platform, before.id, wanted);
      if (!isDeepStrictEqual(wanted, [...before.defaultFor].sort()) || removedFrom.length) {
        set.defaultFor = wanted;
        await entry("org_card_template.defaults_changed", { defaultFor: before.defaultFor }, { defaultFor: wanted, removedFrom });
      }
    }
    if (Object.keys(set).length) await tx.update(orgCardTemplates).set({ ...set, updatedAt: sql`now()` }).where(eq(orgCardTemplates.id, before.id));
    const [row] = await withCreator(tx).where(eq(orgCardTemplates.id, before.id));
    return flat(row!);
  });
}

/** Removes one template (the stored image stays: posted cards keep their own PNG). Audited. False when not found. */
export async function deleteOrgCardTemplate(db: Db, actor: Actor, platform: string, slug: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockOne(tx, actor.orgId, platform, slug);
    const [gone] = await tx.delete(orgCardTemplates).where(one(actor.orgId, platform, slug)).returning();
    if (!gone) return false;
    await audit(tx, {
      orgId: actor.orgId, actorId: actor.id, action: "org_card_template.deleted", entityType: "org_card_template", entityId: gone.id,
      before: {
        platform: gone.platform, slug: gone.slug, label: gone.label, backgroundKey: gone.backgroundKey, width: gone.width, height: gone.height,
        layout: gone.layout, defaultFor: gone.defaultFor, sort: gone.sort, createdBy: gone.createdBy,
      },
      after: null,
    });
    return true;
  });
}

export interface OrgCardTemplateSeed {
  platform: string;
  slug: string;
  label: string;
  /** Storage key of the image, already written by the caller (content-addressed, see the header) */
  backgroundKey: string;
  width: number;
  height: number;
  /** Used for a new row, or for an existing one only when resetLayout is set */
  layout: OrgCardLayout;
  defaultFor: OrgTemplateDefaultFor[];
  sort: number;
}

export type SeedOutcome = "created" | "updated" | "unchanged";

/**
 * Insert or bring up to date one seeded template. An existing row keeps its layout (it may have been
 * tuned in Settings) unless resetLayout; nothing is written when nothing differs, so a re-run is a no-op.
 * Returns the outcome and the key it replaced, if any (the caller removes that file).
 */
export async function upsertOrgCardTemplate(
  db: Db, orgId: string, seed: OrgCardTemplateSeed, opts: { resetLayout?: boolean } = {},
): Promise<{ outcome: SeedOutcome; row: OrgCardTemplate; replacedKey: string | null }> {
  return db.transaction(async (tx) => {
    await lockOrg(tx, orgId, seed.platform);
    await lockOne(tx, orgId, seed.platform, seed.slug);
    const [before] = await tx.select().from(orgCardTemplates).where(one(orgId, seed.platform, seed.slug));
    if (!before) {
      // One default per tag: a tag an admin already gave another template (uploaded before the first seed) stays
      // there, and the new row does without it. Nothing is taken from anyone, so nothing else changes.
      const held = await tx
        .select({ defaultFor: orgCardTemplates.defaultFor })
        .from(orgCardTemplates)
        .where(and(eq(orgCardTemplates.orgId, orgId), eq(orgCardTemplates.platform, seed.platform)));
      const taken = new Set(held.flatMap((r) => r.defaultFor));
      const keptElsewhere = seed.defaultFor.filter((t) => taken.has(t));
      const fields = {
        label: seed.label, backgroundKey: seed.backgroundKey, width: seed.width, height: seed.height,
        defaultFor: seed.defaultFor.filter((t) => !taken.has(t)), sort: seed.sort,
      };
      const [row] = await tx.insert(orgCardTemplates).values({ orgId, platform: seed.platform, slug: seed.slug, layout: seed.layout, ...fields }).returning();
      await audit(tx, {
        orgId, actorId: null, actor: "cli:seed-card-templates", action: "org_card_template.created", entityType: "org_card_template", entityId: row!.id,
        before: null, after: { ...fields, platform: seed.platform, slug: seed.slug, ...(keptElsewhere.length && { keptElsewhere }) },
      });
      return { outcome: "created" as const, row: row!, replacedKey: null };
    }
    // An existing row keeps what the desk can change (label, default tags, order, and the layout unless
    // resetLayout): a re-seed only brings the image up to date.
    const fields = { backgroundKey: seed.backgroundKey, width: seed.width, height: seed.height };
    const same =
      before.backgroundKey === fields.backgroundKey && before.width === fields.width && before.height === fields.height &&
      // Structural: jsonb hands keys back in its own order
      (!opts.resetLayout || isDeepStrictEqual(before.layout, seed.layout));
    if (same) return { outcome: "unchanged" as const, row: before, replacedKey: null };
    const [row] = await tx
      .update(orgCardTemplates)
      .set({ ...fields, ...(opts.resetLayout ? { layout: seed.layout } : {}), updatedAt: sql`now()` })
      .where(eq(orgCardTemplates.id, before.id))
      .returning();
    await audit(tx, {
      orgId, actorId: null, actor: "cli:seed-card-templates", action: "org_card_template.seeded", entityType: "org_card_template", entityId: before.id,
      before: { backgroundKey: before.backgroundKey, width: before.width, height: before.height, ...(opts.resetLayout ? { layout: before.layout } : {}) },
      after: { ...fields, ...(opts.resetLayout ? { layout: seed.layout } : {}) },
    });
    return { outcome: "updated" as const, row: row!, replacedKey: before.backgroundKey !== seed.backgroundKey ? before.backgroundKey : null };
  });
}
