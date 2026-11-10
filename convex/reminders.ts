import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { getUser, requireUser } from "./lib/user";

/** The most reminders an account keeps to come: a Todo of a hundred items, each with every time. */
export const MAX_REMINDERS = 500;
const MAX_KEY = 200;
const MAX_TITLE = 200;
const MAX_BODY = 400;
/** How far ahead one may be: a due years away is not reminded of yet. */
const AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

const reminderV = v.object({ key: v.string(), at: v.number(), title: v.string(), body: v.string() });

/**
 * The account's reminders to come, replaced whole by what a device worked
 * out from the Todo: one kept as it is, one changed sent at its new time,
 * one gone not sent, one new sent at its time. Two devices working them out
 * from the same Todo send the same: nothing changes.
 */
export const replace = mutation({
  args: { reminders: v.array(reminderV) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.reminders.length > MAX_REMINDERS) {
      return { status: "rejected" as const, reason: "tooMany" as const };
    }
    const now = Date.now();
    const wanted = new Map<string, (typeof args.reminders)[number]>();
    for (const reminder of args.reminders) {
      if (
        reminder.key.length === 0 ||
        reminder.key.length > MAX_KEY ||
        reminder.title.length > MAX_TITLE ||
        reminder.body.length > MAX_BODY ||
        !Number.isFinite(reminder.at)
      ) {
        return { status: "rejected" as const, reason: "invalid" as const };
      }
      // Past, or too far ahead: not sent.
      if (reminder.at <= now || reminder.at > now + AHEAD_MS) continue;
      wanted.set(reminder.key, reminder);
    }
    const kept = await ctx.db
      .query("reminders")
      .withIndex("by_user_key", (q) => q.eq("userId", user._id))
      .take(MAX_REMINDERS * 2);
    for (const row of kept) {
      const want = wanted.get(row.key);
      if (want && want.at === row.at && want.title === row.title && want.body === row.body) {
        wanted.delete(row.key);
        continue;
      }
      if (row.scheduledId) await ctx.scheduler.cancel(row.scheduledId);
      if (!want) {
        await ctx.db.delete(row._id);
        continue;
      }
      wanted.delete(row.key);
      const scheduledId = await ctx.scheduler.runAt(want.at, internal.reminders.fire, { reminderId: row._id });
      await ctx.db.patch(row._id, { at: want.at, title: want.title, body: want.body, scheduledId });
    }
    for (const want of wanted.values()) {
      const reminderId = await ctx.db.insert("reminders", { userId: user._id, ...want });
      const scheduledId = await ctx.scheduler.runAt(want.at, internal.reminders.fire, { reminderId });
      await ctx.db.patch(reminderId, { scheduledId });
    }
    return { status: "ok" as const };
  },
});

/** The account's reminders to come, soonest first: for the desktop app, which shows them itself. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_user_key", (q) => q.eq("userId", user._id))
      .take(MAX_REMINDERS);
    return rows
      .map(({ key, at, title, body }) => ({ key, at, title, body }))
      .sort((a, b) => a.at - b.at);
  },
});

/**
 * A reminder's time come: sent to every device of the account that asked
 * for them, and gone. One changed or taken out meanwhile is not sent
 * (its schedule was cancelled; one left over finds it gone).
 */
export const fire = internalMutation({
  args: { reminderId: v.id("reminders") },
  handler: async (ctx, { reminderId }) => {
    const row = await ctx.db.get(reminderId);
    // Gone, or moved later (its new time has a schedule of its own).
    if (!row || row.at > Date.now() + 60_000) return;
    await ctx.db.delete(reminderId);
    const devices = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", row.userId))
      .take(50);
    if (devices.length === 0) return;
    await ctx.scheduler.runAfter(0, internal.push.send, {
      devices: devices.map(({ _id, endpoint, p256dh, auth }) => ({ id: _id, endpoint, p256dh, auth })),
      title: row.title,
      body: row.body,
      tag: row.key,
    });
  },
});
