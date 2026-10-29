// Reads approved stories out of Samvadia's Postgres. Read only, three ways over: the live login should
// be a SELECT-only role, every session is opened with default_transaction_read_only=on, and this file
// only ever sends SELECT. Samvadia's tables are its own; nothing here assumes more than the columns
// listed in SAMVADIA_COLUMNS (see the dummy seed, which creates exactly these).

import pg from "pg";

/** Every Samvadia column Socia reads. The dummy seed creates these and nothing else. */
export const SAMVADIA_COLUMNS = {
  stories: ["id", "item_id", "version", "kind", "slug", "title", "description", "district", "guid", "state", "published_at"],
  items: ["id", "headline", "body", "reporter_slug", "district_code", "kind", "footage_status", "footage_path", "footage_files", "priority", "category"],
} as const;

/** Samvadia's own priority for an item; anything else it might send reads as "normal" */
export const STORY_PRIORITIES = ["normal", "high", "breaking"] as const;
export type StoryPriority = (typeof STORY_PRIORITIES)[number];

export function asPriority(value: unknown): StoryPriority {
  return (STORY_PRIORITIES as readonly unknown[]).includes(value) ? (value as StoryPriority) : "normal";
}

/** A trimmed category, or null when Samvadia has none */
export function asCategory(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

export interface SamvadiaStory {
  id: string;
  itemId: string;
  version: number;
  kind: string;
  slug: string;
  title: string;
  description: string;
  district: string;
  guid: string;
  publishedAt: Date;
  headline: string;
  body: string;
  reporterSlug: string | null;
  districtCode: string | null;
  itemKind: string;
  footageStatus: string | null;
  footagePath: string | null;
  footageFiles: unknown;
  /** Text in Samvadia: 'normal' | 'high' | 'breaking' */
  priority: string | null;
  category: string | null;
}

export interface Cursor {
  publishedAt: string;
  storyId: string;
}

/** What Samvadia's desk may still change on an item after the story went out */
export interface FootageInfo {
  itemId: string;
  footagePath: string | null;
  footageStatus: string | null;
  priority: string | null;
  category: string | null;
}

const STORY_SELECT = `
  SELECT s.id::text AS id, s.item_id::text AS "itemId", s.version, s.kind, s.slug, s.title, s.description, s.district,
         s.guid, s.published_at AS "publishedAt",
         i.headline, i.body, i.reporter_slug AS "reporterSlug", i.district_code AS "districtCode", i.kind AS "itemKind",
         i.footage_status AS "footageStatus", i.footage_path AS "footagePath", i.footage_files AS "footageFiles",
         i.priority, i.category
    FROM stories s
    JOIN items i ON i.id = s.item_id
   WHERE s.state = 'ready' AND s.published_at IS NOT NULL
     AND s.kind = ANY($1::text[]) AND i.kind = ANY($2::text[])`;

export interface ReaderOptions {
  /** Story kinds to take: original and update. A kill carries no text */
  storyKinds?: string[];
  /** Item kinds to take */
  itemKinds?: string[];
  statementTimeoutMs?: number;
  /** Postgres schema holding items and stories, when it is not public (tests use a fixture schema) */
  schema?: string;
}

export interface SamvadiaSource {
  /** Stories after the cursor, oldest first, plus any that committed late inside the overlap window */
  storiesSince(cursor: Cursor, overlapMs: number, limit: number): Promise<{ fresh: SamvadiaStory[]; late: SamvadiaStory[] }>;
  footageFor(itemIds: string[]): Promise<FootageInfo[]>;
  close(): Promise<void>;
}

export class SamvadiaReader implements SamvadiaSource {
  private readonly pool: pg.Pool;
  private readonly storyKinds: string[];
  private readonly itemKinds: string[];

  constructor(url: string, opts: ReaderOptions = {}) {
    const timeout = opts.statementTimeoutMs ?? 15_000;
    if (opts.schema && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error(`Bad schema name: ${opts.schema}`);
    const searchPath = opts.schema ? ` -c search_path=${opts.schema}` : "";
    this.storyKinds = opts.storyKinds ?? ["original", "update"];
    this.itemKinds = opts.itemKinds ?? ["story", "press_release"];
    this.pool = new pg.Pool({
      connectionString: url,
      max: 2,
      application_name: "socia-samvadia-reader",
      // Startup parameters: the server refuses every write in these sessions
      options: `-c default_transaction_read_only=on -c statement_timeout=${timeout}${searchPath}`,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on("error", () => undefined);
  }

  /** Every read runs in an explicit READ ONLY transaction too, for poolers that drop startup options. */
  private async read<T extends pg.QueryResultRow>(text: string, params: unknown[]): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const { rows } = await client.query<T>(text, params);
      await client.query("COMMIT");
      return rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** For tests: prove the session refuses writes. Never used by the worker. */
  async sessionIsReadOnly(): Promise<boolean> {
    const { rows } = await this.pool.query<{ ro: string }>("SELECT current_setting('transaction_read_only') AS ro");
    return rows[0]?.ro === "on";
  }

  async storiesSince(cursor: Cursor, overlapMs: number, limit: number) {
    const fresh = await this.read<SamvadiaStory>(
      `${STORY_SELECT} AND (s.published_at, s.id) > ($3::timestamptz, $4::uuid)
        ORDER BY s.published_at, s.id LIMIT $5`,
      [this.storyKinds, this.itemKinds, cursor.publishedAt, cursor.storyId, limit],
    );
    // A row stamped before the cursor but committed after it moved: look back a little, dedupe later
    const late = await this.read<SamvadiaStory>(
      `${STORY_SELECT} AND s.published_at > $3::timestamptz - make_interval(secs => $5::double precision)
         AND (s.published_at, s.id) <= ($3::timestamptz, $4::uuid)
        ORDER BY s.published_at, s.id LIMIT 1000`,
      [this.storyKinds, this.itemKinds, cursor.publishedAt, cursor.storyId, overlapMs / 1000],
    );
    return { fresh, late };
  }

  async footageFor(itemIds: string[]): Promise<FootageInfo[]> {
    if (!itemIds.length) return [];
    return this.read<FootageInfo>(
      `SELECT id::text AS "itemId", footage_path AS "footagePath", footage_status AS "footageStatus", priority, category
         FROM items WHERE id = ANY($1::uuid[])`,
      [itemIds],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ─── Mapping a Samvadia story to Socia's ─────────────────────────────────────

/** Samvadia's description is: ((note)), "City:", body, "संवाददाता: …". Keep just the body. */
export function bodyFromDescription(description: string): string {
  const paras = description
    .replace(/\(\(.*?\)\)/gs, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length && /^[^\s:]{1,40}:$/u.test(paras[0]!)) paras.shift();
  if (paras.length && /^संवाददाता\s*:/u.test(paras[paras.length - 1]!)) paras.pop();
  return paras.join("\n\n");
}

/** Title is "FLASH <slug>" / "UPDATE <slug>" / "<slug>": not a headline. Use the first sentence of the body instead. */
function firstSentence(body: string): string {
  const line = body.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const cut = line.split(/(?<=[।!?|])\s/u)[0] ?? line;
  return cut.trim();
}

export interface MappedStory {
  externalId: string;
  slug: string;
  headline: string;
  body: string;
  district: string | null;
  sourceText: string;
  parseNote: string | null;
}

export function mapStory(s: SamvadiaStory): MappedStory {
  const body = (s.body ?? "").trim() || bodyFromDescription(s.description ?? "");
  const given = (s.headline ?? "").trim();
  const headline = given || firstSentence(body);
  const notes: string[] = [];
  if (!given) notes.push("Samvadia had no headline; the first sentence of the body is used.");
  if (!(s.body ?? "").trim()) notes.push("Samvadia had no body; it was taken from the feed description.");
  if (s.kind === "update") notes.push(`Update (version ${s.version}) of an earlier story.`);
  return {
    externalId: `${s.id}:v${s.version}`,
    slug: s.slug,
    headline,
    body,
    district: s.district?.trim() || s.districtCode || null,
    sourceText: s.description ?? "",
    parseNote: notes.length ? notes.join(" ") : null,
  };
}
