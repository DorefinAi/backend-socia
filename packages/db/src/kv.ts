import { eq, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { kv } from "./schema";

export async function getKv<T>(db: Executor, key: string): Promise<T | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function setKv(db: Executor, key: string, value: unknown): Promise<void> {
  await db
    .insert(kv)
    .values({ key, value })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: sql`now()` } });
}
