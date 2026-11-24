import { components, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Takes an account out, whoever asks for it (the person in their settings,
 * or an admin): from then on it is no one to sign in as, and its rows go,
 * its files with them, in transactions of their own (users.purgeAccount).
 *
 * Its row is taken from its sign-in at once, so that a second request
 * (another device, a double press, the person and an admin) finds nothing
 * to count out again, and no device writes into what is being purged. Its
 * sign-in goes with it: the Better Auth user, its Google account (name,
 * address, picture, tokens) and every device's session. A device still
 * holding a token cannot make the account again either (users.ensure asks
 * the sign-in, which is gone).
 */
export async function removeAccount(ctx: MutationCtx, user: Doc<"users">): Promise<void> {
  const authId = user.authId;
  await ctx.db.patch(user._id, { authId: `deleted:${authId}` });
  const config = await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
  if (config) {
    await ctx.db.patch(config._id, { userCount: Math.max(0, config.userCount - 1) });
  }
  for (const model of ["session", "account"] as const) {
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model, where: [{ field: "userId", value: authId }] },
      paginationOpts: { numItems: 100, cursor: null },
    });
  }
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "user", where: [{ field: "_id", value: authId }] },
  });
  await ctx.scheduler.runAfter(0, internal.users.purgeAccount, { userId: user._id });
}

/** Whether an account is on its way out (removeAccount): its rows still being purged. */
export const isRemoved = (user: Doc<"users">) => user.authId.startsWith("deleted:");
