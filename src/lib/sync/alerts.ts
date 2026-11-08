"use client";

/**
 * What the storing of edits (lib/sync/docs) tells the sync engine, which
 * shows it: an edit that could not be stored on this device, and the next
 * store that worked. In the style of signal.ts, and apart from the engine,
 * which docs.ts cannot import (the engine imports it).
 */
export type SyncAlert = "saveFailed" | "saveOk";

type Listener = (alert: SyncAlert) => void;
const listeners = new Set<Listener>();

export function onAlert(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportAlert(alert: SyncAlert): void {
  for (const listener of listeners) listener(alert);
}
