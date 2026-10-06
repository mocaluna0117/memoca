import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/** The domain every E2E account is made under (e2e/helpers.ts). */
const TEST_DOMAIN = "@memoca.test";
/** Accounts let go of per transaction; it runs again at once while there are more. */
const BATCH = 25;

/**
 * Deletes the accounts the E2E suite made, with everything they hold: notes,
 * files and their sign-in. Each test makes one, and they otherwise pile up
 * in the team's shared free allowance (database and file storage).
 *
 * Only where TEST_DATA_WIPE is "true", set on the dev and dev/e2e-ci
 * deployments and never on production; and only accounts under the test
 * domain, which Google sign-in never gives.
 *
 *   npx convex run testData:wipe --deployment dev
 */
export const wipe = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    if (process.env.TEST_DATA_WIPE !== "true") {
      throw new Error("Not a test deployment: set TEST_DATA_WIPE=true to wipe E2E accounts here");
    }
    const page = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "user",
      where: [{ field: "email", operator: "ends_with", value: TEST_DOMAIN }],
      paginationOpts: { numItems: BATCH, cursor: cursor ?? null },
    });

    let removed = 0;
    for (const user of page.page as { _id: string; email: string }[]) {
      if (!user.email.endsWith(TEST_DOMAIN)) continue;
      const own = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", user._id))
        .unique();
      if (own) await ctx.scheduler.runAfter(0, internal.users.purgeAccount, { userId: own._id });
      for (const model of ["session", "account"] as const) {
        await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
          input: { model, where: [{ field: "userId", value: user._id }] },
          paginationOpts: { numItems: 100, cursor: null },
        });
      }
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: { model: "user", where: [{ field: "_id", value: user._id }] },
      });
      removed += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.testData.wipe, { cursor: page.continueCursor });
    } else {
      // Counted again from what is left, so sign-up is not held at its limit.
      const config = await ctx.db
        .query("appConfig")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .unique();
      if (config) {
        const left = await ctx.db.query("users").take(10_000);
        const remaining = left.filter((u) => !u.email.endsWith(TEST_DOMAIN)).length;
        await ctx.db.patch(config._id, { userCount: remaining });
      }
    }
    return { removed, done: page.isDone };
  },
});
