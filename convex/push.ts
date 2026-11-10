"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

/** Where a reminder opens, tapped: the quick note's Todo. */
const OPENS = "/quick?todo=1";

/**
 * A reminder sent to each device that asked for them, by its push service
 * (Web Push, signed with the server's VAPID key). A device its service says
 * is gone (404, 410) is taken out. Nothing is sent where no key is set.
 */
export const send = internalAction({
  args: {
    devices: v.array(
      v.object({ id: v.id("pushSubscriptions"), endpoint: v.string(), p256dh: v.string(), auth: v.string() }),
    ),
    title: v.string(),
    body: v.string(),
    tag: v.string(),
  },
  handler: async (ctx, args) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) return;
    // Loaded only where it is used: not at all under convex-test, which runs on the edge runtime.
    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "https://memoca-app.vercel.app", publicKey, privateKey);
    const payload = JSON.stringify({ title: args.title, body: args.body, tag: args.tag, url: OPENS });
    const gone: Id<"pushSubscriptions">[] = [];
    await Promise.all(
      args.devices.map(async (device) => {
        try {
          await webpush.sendNotification(
            { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
            payload,
            // Not shown at all if it cannot be within a day: past its time.
            { TTL: 24 * 60 * 60, urgency: "high" },
          );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(device.id);
        }
      }),
    );
    if (gone.length > 0) await ctx.runMutation(internal.pushSubscriptions.drop, { ids: gone });
  },
});
