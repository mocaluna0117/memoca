"use client";

import { onPeers, tellPeers } from "./peers";

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Lets a local write nudge the sync engine immediately instead of waiting for
 * the next poll. Without it, typing a note title and glancing at the sync
 * indicator shows "unsent" for several seconds when the network is fine.
 *
 * A write in another window of the app on this device nudges it too: only
 * one of them sends (see peers.ts).
 */
export function onOutboxChanged(listener: Listener): () => void {
  listeners.add(listener);
  const stop = onPeers((message) => {
    if (message.kind === "outbox") listener();
  });
  return () => {
    listeners.delete(listener);
    stop();
  };
}

export function notifyOutboxChanged(): void {
  for (const listener of listeners) listener();
  tellPeers({ kind: "outbox" });
}
