// Seeds the org's two house card designs (contract: dev-docs/org-card-templates-contract.md). The images ship
// in apps/api/assets/card-templates/; each is stored through the same Storage as everything else (STORAGE_DIR
// locally, R2 live) under a key that carries a hash of its bytes, and its size is read from the file itself.
// Idempotent: a second run with the same files changes nothing. An existing row keeps its layout (it may have
// been tuned in Settings) unless resetLayout.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertOrgCardTemplate, type Db, type OrgCardLayout, type OrgTemplateDefaultFor, type SeedOutcome } from "@socia/db";
import type { Storage } from "@socia/providers";
import { readImage } from "./routes/templates";

export const CARD_TEMPLATE_ASSETS = fileURLToPath(new URL("../assets/card-templates/", import.meta.url));

export interface OrgTemplateDefinition {
  slug: string;
  label: string;
  file: string;
  layout: OrgCardLayout;
  defaultFor: OrgTemplateDefaultFor[];
  sort: number;
}

export const ORG_CARD_TEMPLATES: readonly OrgTemplateDefinition[] = [
  {
    slug: "breaking-square",
    label: "BREAKING NEWS",
    file: "breaking-square.jpeg",
    layout: {
      date: { x: 0.537, y: 0.186, w: 0.421, h: 0.052, color: "#000000", format: "Date:DD/MM/YYYY" },
      box: { x: 0.085, y: 0.285, w: 0.83, h: 0.56 },
      headline: { color: "#FFE600" },
      body: { color: "#FFFFFF" },
      fontMinPx: 18,
      fontMaxPx: 56,
    },
    defaultFor: ["breaking"],
    sort: 0,
  },
  {
    slug: "badi-khabar",
    label: "बड़ी ख़बर",
    file: "badi-khabar.jpeg",
    // No date on this design
    layout: {
      date: null,
      box: { x: 0.08, y: 0.37, w: 0.84, h: 0.55 },
      headline: { color: "#FFE600" },
      body: { color: "#FFFFFF" },
      fontMinPx: 20,
      fontMaxPx: 64,
    },
    defaultFor: ["big_breaking"],
    sort: 1,
  },
];

export interface SeedResult {
  slug: string;
  outcome: SeedOutcome;
  width: number;
  height: number;
  key: string;
}

export async function seedOrgCardTemplates(
  db: Db, storage: Storage, orgId: string,
  opts: { resetLayout?: boolean; assetsDir?: string; templates?: readonly OrgTemplateDefinition[] } = {},
): Promise<SeedResult[]> {
  const dir = opts.assetsDir ?? CARD_TEMPLATE_ASSETS;
  const out: SeedResult[] = [];
  for (const def of opts.templates ?? ORG_CARD_TEMPLATES) {
    const body = await readFile(join(dir, def.file));
    // Throws on a file that is not a readable PNG/JPEG
    const image = readImage(body);
    const ext = image.contentType === "image/png" ? "png" : "jpg";
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const key = `card-templates/org/${orgId}/${def.slug}-${hash}.${ext}`;
    // Same bytes, same key: writing it again is harmless and heals a missing file
    await storage.put(key, body, image.contentType);
    const { outcome, replacedKey } = await upsertOrgCardTemplate(db, orgId, {
      platform: "x", slug: def.slug, label: def.label, backgroundKey: key, width: image.width, height: image.height,
      layout: def.layout, defaultFor: def.defaultFor, sort: def.sort,
    }, { resetLayout: opts.resetLayout });
    if (replacedKey) await storage.delete(replacedKey).catch(() => undefined);
    out.push({ slug: def.slug, outcome, width: image.width, height: image.height, key });
  }
  return out;
}
