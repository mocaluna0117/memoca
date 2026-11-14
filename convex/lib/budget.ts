import type { MutationCtx } from "../_generated/server";

/**
 * What a transaction keeps back, of what it may read and write, for the step
 * it is about to take: a note's snapshot or an update kept inline can be
 * 900 KB (SNAPSHOT_INLINE_LIMIT), and a purge of one note reads its own.
 */
const BYTES_RESERVE = 4 * 1024 * 1024;
const WRITES_RESERVE = 200;

/**
 * Whether a bulk delete should stop here and leave the rest to the next
 * transaction. Counted by rows alone (200 at a time), a user's large rows
 * read past the 16 MiB a transaction may: it failed whole, and was never
 * tried again.
 */
export async function nearLimit(ctx: MutationCtx): Promise<boolean> {
  const metrics = await ctx.meta.getTransactionMetrics();
  return (
    metrics.bytesRead.remaining < BYTES_RESERVE ||
    metrics.bytesWritten.remaining < BYTES_RESERVE ||
    metrics.documentsWritten.remaining < WRITES_RESERVE ||
    metrics.documentsRead.remaining < WRITES_RESERVE
  );
}
