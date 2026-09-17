"use client";

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Lets a local write nudge the sync engine immediately instead of waiting for
 * the next poll. Without it, typing a note title and glancing at the sync
 * indicator shows "unsent" for several seconds when the network is fine.
 */
export function onOutboxChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyOutboxChanged(): void {
  for (const listener of listeners) listener();
}
