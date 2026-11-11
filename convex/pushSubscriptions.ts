import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/user";

/** The most devices an account has the reminders sent to: the oldest goes past it. */
const MAX_DEVICES = 20;
const MAX_ENDPOINT = 2000;
const MAX_KEY = 200;

/** The key the server signs its pushes with (VAPID), public: a device subscribes with it. Null where none is set. */
export const publicKey = query({
  args: {},
  // An empty one (set with nothing piped in) is none either.
  handler: async () => process.env.VAPID_PUBLIC_KEY || null,
});

/**
 * This device asks for the Todo's reminders: its push subscription kept for
 * the account (asked again, as the app opens, it is the same row; one its
 * browser renewed is the new). A device another account had is this one's
 * now.
 */
export const subscribe = mutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (
      !args.endpoint.startsWith("https://") ||
      args.endpoint.length > MAX_ENDPOINT ||
      args.p256dh.length > MAX_KEY ||
      args.auth.length > MAX_KEY
    ) {
      return { status: "rejected" as const, reason: "invalid" as const };
    }
    const there = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .take(10);
    for (const row of there) {
      if (row.userId === user._id && row.p256dh === args.p256dh && row.auth === args.auth) {
        return { status: "ok" as const };
      }
      await ctx.db.delete(row._id);
    }
    const own = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_DEVICES * 2);
    const oldest = [...own].sort((a, b) => a.createdAt - b.createdAt);
    for (const row of oldest.slice(0, Math.max(0, oldest.length - MAX_DEVICES + 1))) await ctx.db.delete(row._id);
    await ctx.db.insert("pushSubscriptions", { userId: user._id, ...args, createdAt: Date.now() });
    return { status: "ok" as const };
  },
});

/** This device no longer has the reminders sent to it (turned off, or signed out). */
export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const user = await requireUser(ctx);
    for (const row of await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .take(10)) {
      if (row.userId === user._id) await ctx.db.delete(row._id);
    }
    return { status: "ok" as const };
  },
});

/** Devices their push service says are gone (push.send). */
export const drop = internalMutation({
  args: { ids: v.array(v.id("pushSubscriptions")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      if (await ctx.db.get(id)) await ctx.db.delete(id);
    }
  },
});
