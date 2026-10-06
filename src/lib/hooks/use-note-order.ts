"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type NoteOrder, isNoteOrder } from "@/lib/note-order";

/** Where this device keeps each list's order: by folder, or "all" for all notes. */
const KEY = "memoca:note-order";

const listeners = new Set<() => void>();

/** What is kept, as kept: the same string while it is unchanged. */
function stored(): string {
  try {
    return localStorage.getItem(KEY) ?? "{}";
  } catch {
    return "{}";
  }
}

/** Each list's order as set, where one is. */
function orders(raw = stored()): Record<string, NoteOrder> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, NoteOrder] => isNoteOrder(entry[1])),
    );
  } catch {
    // Storage refused (a private window, say), or not ours: as it starts.
    return {};
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab of the app set it.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Sets a list's order on this device: a folder's (by its id), or all notes' (`null`). */
export function setNoteOrder(folderId: string | null, order: NoteOrder) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...orders(), [folderId ?? "all"]: order }));
  } catch {
    // Refused: it stays as it was.
  }
  for (const listener of listeners) listener();
}

/**
 * A list's order until one is set: a folder's as placed by hand (a note made
 * goes first), all notes' last changed first. All notes, of every folder,
 * have no one order to be placed in.
 */
const orderUnset = (folderId: string | null): NoteOrder => (folderId === null ? "updated" : "manual");

/**
 * How a list of notes is ordered on this device, and a way to set it: a
 * folder's list (by its id), or all notes (`null`), each its own, as
 * {@link orderUnset} until set. By hand only for a folder.
 *
 * Kept on this device only, as a view of the list; the order notes are
 * placed in by hand is the notes' own, and every device shares it.
 */
export function useNoteOrder(folderId: string | null): [NoteOrder, (order: NoteOrder) => void] {
  const scope = folderId ?? "all";
  const order = useSyncExternalStore(
    subscribe,
    () => orders()[scope] ?? orderUnset(folderId),
    () => orderUnset(folderId),
  );
  const set = useCallback((next: NoteOrder) => setNoteOrder(folderId, next), [folderId]);
  return [folderId === null && order === "manual" ? "updated" : order, set];
}

/**
 * Every folder's order, by its id, as {@link useNoteOrder} gives each one
 * (placed by hand, where none is set): for the sidebar's tree, which
 * shows the notes of many folders at once.
 */
export function useNoteOrders(): (folderId: string) => NoteOrder {
  const raw = useSyncExternalStore(subscribe, stored, () => "{}");
  return useMemo(() => {
    const set = orders(raw);
    return (folderId: string) => set[folderId] ?? orderUnset(folderId);
  }, [raw]);
}
