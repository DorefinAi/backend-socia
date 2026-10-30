// One bad breaking story must not stop the pipeline. withNextStory rolls the whole unit back when the work
// throws, so the same story would be picked again forever; here the failure is caught, and the story is marked
// failed in a statement of its own (the transaction is gone by then). A data file that cannot be read is
// different: every story would fail the same way, so it is passed on and the loop backs off and retries.
// Only breaking stories are handled like this; the other layouts keep their old behaviour.

import { stories, withNextStory, type Db, type Tx } from "@socia/db";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { DataUnavailable } from "../data-files";

type Story = typeof stories.$inferSelect;

export async function nextStoryIsolated(
  db: Db, status: "ingested" | "converted", log: Logger, stage: string, work: (tx: Tx, story: Story) => Promise<void>,
): Promise<boolean> {
  let current = null as Story | null;
  try {
    return await withNextStory(db, status, async (tx, story) => {
      current = story;
      await work(tx, story);
    });
  } catch (err) {
    if (err instanceof DataUnavailable || !current || current.layout !== "breaking") throw err;
    const message = `Could not ${stage} this file: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
    // Only if no one moved it meanwhile
    await db
      .update(stories)
      .set({ status: "failed", lastError: message, updatedAt: sql`now()` })
      .where(and(eq(stories.id, current.id), eq(stories.status, status)));
    log.error({ err, storyId: current.id, stage }, "breaking story failed; marked failed, pipeline goes on");
    return true;
  }
}
