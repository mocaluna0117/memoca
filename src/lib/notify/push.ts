"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";

/**
 * This device's part in the Todo's reminders: its browser asked to show
 * them (the Notification permission), and its push subscription (Web Push,
 * by the service worker, src/app/sw.ts) given to the server, which sends
 * each reminder to every device of the account that has one there.
 */

/** Where this device stands: why it cannot, or whether it does. */
export type PushState =
  /** Its browser has no Web Push (the desktop app's window among them). */
  | "unsupported"
  /** An iPhone or iPad, in Safari: only as an app put on the home screen (iOS 16.4 or later). */
  | "needsInstall"
  /** Told not to show notifications: only its settings can undo that. */
  | "denied"
  | "off"
  | "on";

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window &&
  // The desktop app's window has none to speak of: it shows them itself.
  !window.memocaShell;

/** The worker's registration, if one is running: none, for a page with no worker (in development). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const found = await navigator.serviceWorker.getRegistration();
  if (!found) return null;
  return navigator.serviceWorker.ready;
}

/** Where this device stands now. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !standalone() ? "needsInstall" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration();
  if (!reg) return "unsupported";
  const subscription = await reg.pushManager.getSubscription();
  return subscription && Notification.permission === "granted" ? "on" : "off";
}

/** A key in URL-safe base64, as the push manager takes it. */
function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** What the server is given of a subscription. */
function partsOf(subscription: PushSubscription) {
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
  return { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth };
}

/**
 * This device asks for the reminders: the browser asked (once), the
 * subscription made, and given to the server. What it stands at after:
 * "on", or why not.
 */
export async function turnOn(convex: ConvexReactClient): Promise<PushState> {
  if (!pushSupported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  if (!reg) return "unsupported";
  const key = await convex.query(api.pushSubscriptions.publicKey, {});
  if (!key) return "unsupported";
  let subscription = await reg.pushManager.getSubscription();
  if (subscription) {
    // One made with another key (the server's changed) is no use: made again.
    const used = subscription.options.applicationServerKey;
    const wanted = keyBytes(key);
    const same =
      used !== null &&
      used.byteLength === wanted.byteLength &&
      new Uint8Array(used).every((byte, i) => byte === wanted[i]);
    if (!same) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const parts = partsOf(subscription);
  if (!parts) return "off";
  const result = await convex.mutation(api.pushSubscriptions.subscribe, parts);
  return result.status === "ok" ? "on" : "off";
}

/** How long turning off waits for the server to be told. */
const TOLD_WITHIN_MS = 3_000;

/** This device no longer asks for them: taken off the server, and its subscription dropped. */
export async function turnOff(convex: ConvexReactClient): Promise<void> {
  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;
  // The server told, for as long as TOLD_WITHIN_MS: with no connection a
  // mutation neither answers nor fails (it waits for the network), and what
  // waited on it waited too: 「ログアウト」 did nothing, offline, on a
  // device with reminders on. The subscription is dropped here whatever
  // comes of it, so nothing more is shown on this device; the server drops
  // an address that no longer takes what is sent to it.
  await Promise.race([
    convex.mutation(api.pushSubscriptions.unsubscribe, { endpoint: subscription.endpoint }).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, TOLD_WITHIN_MS)),
  ]);
  await subscription.unsubscribe().catch(() => false);
}

/**
 * As the app opens: this device's subscription, if it has one, given to the
 * server again (renewed by its browser meanwhile, or the server's row gone
 * as a send failed once). Once a page.
 */
let told = false;
export async function tellServerAgain(convex: ConvexReactClient): Promise<void> {
  if (told || !pushSupported() || Notification.permission !== "granted") return;
  told = true;
  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  const parts = subscription ? partsOf(subscription) : null;
  if (parts) await convex.mutation(api.pushSubscriptions.subscribe, parts).catch(() => undefined);
}
