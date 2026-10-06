"use client";

/**
 * What one window of the app on this device tells the others: its tabs, or
 * the desktop app's two windows (the quick note's and Memoca's own).
 *
 * Only one of them syncs (see SyncEngine's leadership), and each keeps its
 * own copy of the notes it has open. Without this, an edit made in a window
 * that does not sync waited for the one that does to look at the outbox on
 * its own (every few seconds, less often while it is hidden, as the quick
 * note's window mostly is), and a change from another device reached only
 * the window that syncs: a note open in the other showed it once opened
 * again.
 *
 * - `outbox`: something is waiting to be sent; the window that syncs sends it.
 * - `update`: a change to a note that is not locked, stored already, for a
 *   window with it open to take in.
 * - `reload`: a locked note changed, stored already: a window with it open
 *   reads it again from storage, with its own vault. Its text is not passed
 *   between windows, where one with the vault closed would get it.
 */
export type PeerMessage =
  | { kind: "outbox" }
  | { kind: "update"; noteId: string; update: Uint8Array }
  | { kind: "reload"; noteId: string };

const NAME = "memoca-sync";
let channel: BroadcastChannel | null | undefined;

function opened(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(NAME);
  }
  return channel;
}

/** Tells this device's other windows; nothing where there are none to tell. */
export function tellPeers(message: PeerMessage): void {
  try {
    opened()?.postMessage(message);
  } catch {
    // Closed as the page goes: nobody left to tell.
  }
}

/** What this device's other windows tell this one. */
export function onPeers(listener: (message: PeerMessage) => void): () => void {
  const ch = opened();
  if (!ch) return () => {};
  const receive = (event: MessageEvent<PeerMessage>) => listener(event.data);
  ch.addEventListener("message", receive);
  return () => ch.removeEventListener("message", receive);
}
