import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MAX_TRACKED_DEVICES } from "./constants";

/**
 * Hands out the per-user sync sequence.
 *
 * Every syncable row written in a mutation gets a number from `next()`. Because
 * all of them come from one `syncHeads` document, Convex's optimistic
 * concurrency control serialises concurrent mutations for the same user: a
 * transaction that commits later always holds a larger sequence. That is what
 * lets a client say "give me everything after N" and know nothing can ever be
 * inserted behind its cursor. Wall-clock time cannot offer that guarantee.
 *
 * Call `commit()` exactly once, at the end of the mutation.
 */
export async function openSeq(ctx: MutationCtx, userId: Id<"users">) {
  const existing = await ctx.db
    .query("syncHeads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  const headId =
    existing?._id ??
    (await ctx.db.insert("syncHeads", { userId, seq: 0, lastPushByDevice: {} }));

  let cursor = existing?.seq ?? 0;
  const devices: Record<string, number> = { ...(existing?.lastPushByDevice ?? {}) };
  const startedAt = cursor;

  return {
    /** Allocate the next sequence. Only call this when actually writing a row. */
    next: () => ++cursor,
    /** The sequence as it stands, without allocating. */
    peek: () => cursor,
    /** True when nothing was written, so the head does not need touching. */
    get untouched() {
      return cursor === startedAt;
    },
    /** Last-seen times of the user's other devices, as of the start of this mutation. */
    otherDevices: (self: string) =>
      Object.entries(devices).filter(([id]) => id !== self),

    async commit(deviceId?: string) {
      if (deviceId) {
        devices[deviceId] = Date.now();
        const entries = Object.entries(devices).sort((a, b) => b[1] - a[1]);
        if (entries.length > MAX_TRACKED_DEVICES) {
          for (const [id] of entries.slice(MAX_TRACKED_DEVICES)) delete devices[id];
        }
      }
      if (cursor === startedAt && !deviceId) return;
      await ctx.db.patch(headId, { seq: cursor, lastPushByDevice: devices });
    },
  };
}

export type SeqWriter = Awaited<ReturnType<typeof openSeq>>;
