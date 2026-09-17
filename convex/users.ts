import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { authComponent } from "./auth";
import { DEFAULTS } from "./lib/constants";
import { openSeq } from "./lib/seq";
import { getConfig, getUser, requireUser } from "./lib/user";

async function getOrCreateConfig(ctx: MutationCtx): Promise<Doc<"appConfig">> {
  const existing = await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
  if (existing) return existing;
  const id = await ctx.db.insert("appConfig", {
    key: "global",
    signupOpen: DEFAULTS.signupOpen,
    maxUsers: DEFAULTS.maxUsers,
    userCount: 0,
    defaultQuotaBytes: DEFAULTS.defaultQuotaBytes,
    maxImageBytes: DEFAULTS.maxImageBytes,
    maxVideoBytes: DEFAULTS.maxVideoBytes,
  });
  return (await ctx.db.get(id))!;
}

function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

/**
 * Provisions the app-side row for a freshly signed-in Better Auth account.
 *
 * Sign-up closes on its own once the free tier is full, and stays open to
 * anyone holding an invite code, so the service can be public without the
 * storage bill being open-ended.
 */
export const ensure = mutation({
  args: {
    deviceId: v.string(),
    /** Client-generated id for the Inbox folder, used only on first sign-in. */
    inboxFolderId: v.string(),
    inviteCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUser = await authComponent.safeGetAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError({ code: "UNAUTHENTICATED", message: "サインインが必要です。" });
    }
    const authId = authUser._id as string;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .unique();

    if (existing) {
      const inbox = await ctx.db
        .query("folders")
        .withIndex("by_user_system", (q) => q.eq("userId", existing._id).eq("system", "inbox"))
        .unique();
      return { status: "ok" as const, inboxFolderId: inbox?.folderId ?? null };
    }

    const config = await getOrCreateConfig(ctx);
    const now = Date.now();
    const email = authUser.email;
    const admin = isAdminEmail(email);

    let invite: Doc<"inviteCodes"> | null = null;
    const atCapacity = !config.signupOpen || config.userCount >= config.maxUsers;
    if (atCapacity && !admin) {
      if (!args.inviteCode) return { status: "closed" as const, inboxFolderId: null };
      invite = await ctx.db
        .query("inviteCodes")
        .withIndex("by_code", (q) => q.eq("code", args.inviteCode!.trim().toUpperCase()))
        .unique();
      const usable =
        invite && invite.usesLeft > 0 && (invite.expiresAt === null || invite.expiresAt > now);
      if (!usable) return { status: "badInvite" as const, inboxFolderId: null };
    }

    const userId = await ctx.db.insert("users", {
      authId,
      email,
      name: authUser.name,
      image: authUser.image ?? undefined,
      role: admin ? "admin" : "user",
      quotaBytes: config.defaultQuotaBytes,
      usedBytes: 0,
      reservedBytes: 0,
      settings: {
        theme: "system",
        trashRetentionDays: DEFAULTS.trashRetentionDays,
        autoLockMinutes: DEFAULTS.autoLockMinutes,
        prefetchBodies: true,
      },
      createdAt: now,
    });

    const seq = await openSeq(ctx, userId);
    await ctx.db.insert("folders", {
      userId,
      folderId: args.inboxFolderId,
      parentId: null,
      name: "Inbox",
      icon: "inbox",
      sortKey: "a0",
      locked: false,
      system: "inbox",
      deletedAt: null,
      purged: false,
      ts: {
        name: { t: now, d: args.deviceId },
        place: { t: now, d: args.deviceId },
        trash: { t: 0, d: args.deviceId },
        lock: { t: 0, d: args.deviceId },
      },
      deviceId: args.deviceId,
      seq: seq.next(),
    });
    await seq.commit(args.deviceId);

    await ctx.db.patch(config._id, { userCount: config.userCount + 1 });
    if (invite) await ctx.db.patch(invite._id, { usesLeft: invite.usesLeft - 1 });

    return { status: "created" as const, inboxFolderId: args.inboxFolderId };
  },
});

/** Everything the shell needs about the signed-in person, in one subscription. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUser(ctx);
    if (!user) return null;
    const inbox = await ctx.db
      .query("folders")
      .withIndex("by_user_system", (q) => q.eq("userId", user._id).eq("system", "inbox"))
      .unique();
    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    const config = await getConfig(ctx);
    return {
      email: user.email,
      name: user.name ?? null,
      image: user.image ?? null,
      role: user.role,
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
      reservedBytes: user.reservedBytes,
      settings: user.settings,
      inboxFolderId: inbox?.folderId ?? null,
      hasVault: vault !== null,
      limits: { maxImageBytes: config.maxImageBytes, maxVideoBytes: config.maxVideoBytes },
      createdAt: user.createdAt,
    };
  },
});

export const updateSettings = mutation({
  args: {
    theme: v.optional(v.union(v.literal("system"), v.literal("light"), v.literal("dark"))),
    trashRetentionDays: v.optional(v.number()),
    autoLockMinutes: v.optional(v.number()),
    prefetchBodies: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const allowedRetention = [7, 30, 90];
    const settings = {
      ...user.settings,
      ...(args.theme !== undefined ? { theme: args.theme } : {}),
      ...(args.trashRetentionDays !== undefined &&
      allowedRetention.includes(args.trashRetentionDays)
        ? { trashRetentionDays: args.trashRetentionDays }
        : {}),
      ...(args.autoLockMinutes !== undefined
        ? { autoLockMinutes: Math.min(Math.max(args.autoLockMinutes, 1), 60) }
        : {}),
      ...(args.prefetchBodies !== undefined ? { prefetchBodies: args.prefetchBodies } : {}),
    };
    await ctx.db.patch(user._id, { settings });
    return settings;
  },
});

/** Whether a new visitor can sign up right now, for the landing page. */
export const signupStatus = query({
  args: {},
  handler: async (ctx) => {
    const config = await getConfig(ctx);
    return {
      open: config.signupOpen && config.userCount < config.maxUsers,
      userCount: config.userCount,
      maxUsers: config.maxUsers,
    };
  },
});

/**
 * Removes every trace of the signed-in person's notes.
 *
 * Runs in scheduled batches because a full account can hold far more rows than
 * one transaction may touch. The Better Auth account itself is deleted from the
 * client afterwards, through the normal auth route.
 */
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const config = await ctx.db
      .query("appConfig")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    if (config) {
      await ctx.db.patch(config._id, { userCount: Math.max(0, config.userCount - 1) });
    }
    await ctx.scheduler.runAfter(0, internal.users.purgeAccount, { userId: user._id });
    return { status: "scheduled" as const };
  },
});

export const purgeAccount = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const BATCH = 200;
    let work = BATCH;

    type PurgeableId =
      | Id<"noteUpdates">
      | Id<"noteSnapshots">
      | Id<"attachments">
      | Id<"notes">
      | Id<"folders">;

    const drop = async (rows: { _id: PurgeableId }[]) => {
      for (const row of rows) {
        await ctx.db.delete(row._id);
        work -= 1;
      }
    };

    const updates = await ctx.db
      .query("noteUpdates")
      .withIndex("by_user_seq", (q) => q.eq("userId", userId))
      .take(work);
    await drop(updates);

    if (work > 0) {
      const snapshots = await ctx.db
        .query("noteSnapshots")
        .withIndex("by_user_seq", (q) => q.eq("userId", userId))
        .take(work);
      for (const row of snapshots) {
        if (row.storageId) await ctx.storage.delete(row.storageId);
      }
      await drop(snapshots);
    }
    if (work > 0) {
      const attachments = await ctx.db
        .query("attachments")
        .withIndex("by_user_seq", (q) => q.eq("userId", userId))
        .take(work);
      for (const row of attachments) {
        if (row.storageId) await ctx.storage.delete(row.storageId);
      }
      await drop(attachments);
    }
    if (work > 0) {
      const notes = await ctx.db
        .query("notes")
        .withIndex("by_user_seq", (q) => q.eq("userId", userId))
        .take(work);
      await drop(notes);
    }
    if (work > 0) {
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_user_seq", (q) => q.eq("userId", userId))
        .take(work);
      await drop(folders);
    }

    if (work <= 0) {
      await ctx.scheduler.runAfter(0, internal.users.purgeAccount, { userId });
      return;
    }

    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (vault) await ctx.db.delete(vault._id);
    const head = await ctx.db
      .query("syncHeads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (head) await ctx.db.delete(head._id);
    await ctx.db.delete(userId);
  },
});
