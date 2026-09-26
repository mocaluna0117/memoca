import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { DEFAULTS } from "./lib/constants";
import { requireAdmin } from "./lib/user";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const config = await ctx.db
      .query("appConfig")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    const users = await ctx.db.query("users").take(200);
    const invites = await ctx.db.query("inviteCodes").take(100);
    return {
      config: {
        signupOpen: config?.signupOpen ?? DEFAULTS.signupOpen,
        maxUsers: config?.maxUsers ?? DEFAULTS.maxUsers,
        userCount: config?.userCount ?? users.length,
        defaultQuotaBytes: config?.defaultQuotaBytes ?? DEFAULTS.defaultQuotaBytes,
        maxImageBytes: config?.maxImageBytes ?? DEFAULTS.maxImageBytes,
        maxVideoBytes: config?.maxVideoBytes ?? DEFAULTS.maxVideoBytes,
      },
      users: users.map((u) => ({
        email: u.email,
        name: u.name ?? null,
        role: u.role,
        quotaBytes: u.quotaBytes,
        usedBytes: u.usedBytes,
        reservedBytes: u.reservedBytes,
        createdAt: u.createdAt,
      })),
      invites: invites.map((i) => ({
        code: i.code,
        usesLeft: i.usesLeft,
        expiresAt: i.expiresAt,
        memo: i.memo ?? null,
        createdAt: i.createdAt,
      })),
    };
  },
});

export const setConfig = mutation({
  args: {
    signupOpen: v.optional(v.boolean()),
    maxUsers: v.optional(v.number()),
    defaultQuotaBytes: v.optional(v.number()),
    maxImageBytes: v.optional(v.number()),
    maxVideoBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("appConfig")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    const next = {
      key: "global" as const,
      signupOpen: args.signupOpen ?? existing?.signupOpen ?? DEFAULTS.signupOpen,
      maxUsers: args.maxUsers ?? existing?.maxUsers ?? DEFAULTS.maxUsers,
      userCount: existing?.userCount ?? 0,
      defaultQuotaBytes:
        args.defaultQuotaBytes ?? existing?.defaultQuotaBytes ?? DEFAULTS.defaultQuotaBytes,
      maxImageBytes: args.maxImageBytes ?? existing?.maxImageBytes ?? DEFAULTS.maxImageBytes,
      maxVideoBytes: args.maxVideoBytes ?? existing?.maxVideoBytes ?? DEFAULTS.maxVideoBytes,
    };
    if (existing) await ctx.db.patch(existing._id, next);
    else await ctx.db.insert("appConfig", next);
    return next;
  },
});

export const createInvite = mutation({
  args: {
    uses: v.number(),
    expiresInDays: v.union(v.number(), v.null()),
    memo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const code = randomCode();
    await ctx.db.insert("inviteCodes", {
      code,
      createdBy: admin._id,
      usesLeft: Math.min(Math.max(args.uses, 1), 100),
      expiresAt:
        args.expiresInDays === null
          ? null
          : Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000,
      memo: args.memo,
      createdAt: Date.now(),
    });
    return code;
  },
});

export const revokeInvite = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("inviteCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

/** Updates one person's storage allowance from the admin screen. */
export const setUserQuota = mutation({
  args: { email: v.string(), quotaBytes: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const target = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (!target) return { status: "notFound" as const };
    await ctx.db.patch(target._id, { quotaBytes: Math.max(0, args.quotaBytes) });
    return { status: "ok" as const };
  },
});

/** Recomputes a user's storage total from their rows. */
export const recomputeUsage = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!user) return null;

    let used = 0;
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_user_seq", (q) => q.eq("userId", user._id))
      .take(5000);
    for (const note of notes) used += note.bodyBytes;
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_user_seq", (q) => q.eq("userId", user._id))
      .take(5000);
    // Not all of them read: a partial sum would be written as the total.
    if (notes.length === 5000 || attachments.length === 5000) return null;
    // A file deleted since, by the sweep or with its note, gave its bytes back.
    for (const row of attachments) if (row.status === "committed" && row.deletedAt === null) used += row.bytes;

    await ctx.db.patch(user._id, { usedBytes: used });
    return used;
  },
});

/**
 * Raises the registration cap on a development deployment.
 *
 * The end-to-end suite creates a throwaway account per test, which would
 * otherwise hit the free-tier cap after a few dozen runs. Refuses to run
 * unless the deployment has explicitly opted into test mode.
 */
export const devRaiseCapacity = internalMutation({
  args: { maxUsers: v.number() },
  handler: async (ctx, { maxUsers }) => {
    if (process.env.ALLOW_PASSWORD_AUTH !== "true") {
      throw new Error("本番デプロイでは実行できません。");
    }
    const existing = await ctx.db
      .query("appConfig")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { maxUsers, signupOpen: true });
    } else {
      await ctx.db.insert("appConfig", {
        key: "global",
        signupOpen: true,
        maxUsers,
        userCount: 0,
        defaultQuotaBytes: DEFAULTS.defaultQuotaBytes,
        maxImageBytes: DEFAULTS.maxImageBytes,
        maxVideoBytes: DEFAULTS.maxVideoBytes,
      });
    }
    return maxUsers;
  },
});
