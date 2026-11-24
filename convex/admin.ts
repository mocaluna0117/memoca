import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { isRemoved, removeAccount } from "./lib/account";
import { DEFAULTS } from "./lib/constants";
import { hasAdminAccess, requireAdmin } from "./lib/user";

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
    // The newest first: those who signed up last are the ones looked for.
    const users = await ctx.db.query("users").order("desc").take(200);
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
      /** What everyone has stored, all told. */
      usedBytes: users.reduce((sum, u) => sum + u.usedBytes + u.reservedBytes, 0),
      users: users.map((u) => ({
        id: u._id,
        email: u.email,
        name: u.name ?? null,
        role: u.role,
        quotaBytes: u.quotaBytes,
        usedBytes: u.usedBytes,
        reservedBytes: u.reservedBytes,
        createdAt: u.createdAt,
        /** Taken out (removeAccount), its rows still being purged. */
        removed: isRemoved(u),
        /** An admin, by role or ADMIN_EMAILS: not one to take out from here. */
        admin: hasAdminAccess(u),
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
    // Everyone still on the old default moves to the new one; a quota set
    // for one person by hand stays as it is.
    const before = existing?.defaultQuotaBytes ?? DEFAULTS.defaultQuotaBytes;
    if (next.defaultQuotaBytes !== before) {
      await ctx.scheduler.runAfter(0, internal.admin.applyDefaultQuota, {
        from: before,
        to: next.defaultQuotaBytes,
        cursor: null,
      });
    }
    return next;
  },
});

/** People moved to a new default quota per transaction; it runs again while there are more. */
const QUOTA_BATCH = 200;

export const applyDefaultQuota = internalMutation({
  args: { from: v.number(), to: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, cursor }) => {
    const page = await ctx.db.query("users").paginate({ numItems: QUOTA_BATCH, cursor });
    for (const user of page.page) {
      if (user.quotaBytes === from) await ctx.db.patch(user._id, { quotaBytes: to });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.admin.applyDefaultQuota, {
        from,
        to,
        cursor: page.continueCursor,
      });
    }
  },
});

export const createInvite = mutation({
  args: {
    uses: v.number(),
    /** Good for this many days from now; null, for good. Ignored when `expiresAt` is given. */
    expiresInDays: v.union(v.number(), v.null()),
    /** Good until this moment (ms), chosen on the admin screen: the end of a day there. */
    expiresAt: v.optional(v.number()),
    memo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const now = Date.now();
    if (args.expiresAt !== undefined && !(Number.isFinite(args.expiresAt) && args.expiresAt > now)) {
      throw new ConvexError({ code: "BAD_EXPIRY", message: "期限は、いまより先の日時にしてください。" });
    }
    const code = randomCode();
    await ctx.db.insert("inviteCodes", {
      code,
      createdBy: admin._id,
      usesLeft: Math.min(Math.max(Math.floor(args.uses) || 1, 1), 100),
      expiresAt:
        args.expiresAt !== undefined
          ? args.expiresAt
          : args.expiresInDays === null
            ? null
            : now + args.expiresInDays * 24 * 60 * 60 * 1000,
      memo: args.memo?.trim() || undefined,
      createdAt: now,
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

/** The most one person may be given, whatever is typed: 100 GB. */
const MAX_QUOTA_BYTES = 100 * 1024 * 1024 * 1024;

/**
 * One person's storage allowance, set from the admin screen. Set to exactly
 * the default, it is the default's again: it follows the next change of it
 * (applyDefaultQuota). Less than they use already, nothing is deleted:
 * nothing more can be added until they are under it again.
 */
export const setUserQuota = mutation({
  args: { userId: v.id("users"), quotaBytes: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (!Number.isFinite(args.quotaBytes) || args.quotaBytes < 0 || args.quotaBytes > MAX_QUOTA_BYTES) {
      throw new ConvexError({ code: "BAD_QUOTA", message: "容量は 0 から 100 GB のあいだで指定してください。" });
    }
    const target = await ctx.db.get("users", args.userId);
    if (!target || isRemoved(target)) return { status: "notFound" as const };
    await ctx.db.patch("users", target._id, { quotaBytes: Math.round(args.quotaBytes) });
    return { status: "ok" as const };
  },
});

/**
 * Takes someone's account out, from the admin screen, as they can from their
 * own settings (removeAccount): signed out on every device, their notes and
 * files deleted, counted out of the sign-up limit. Never one's own (that is
 * for the settings, which also clear this device), nor an admin's.
 */
export const removeUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const admin = await requireAdmin(ctx);
    const target = await ctx.db.get("users", userId);
    if (!target || isRemoved(target)) return { status: "gone" as const };
    if (target._id === admin._id) return { status: "self" as const };
    if (hasAdminAccess(target)) return { status: "admin" as const };
    await removeAccount(ctx, target);
    return { status: "scheduled" as const };
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
