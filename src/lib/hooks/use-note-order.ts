"use client";

import { useCallback, useSyncExternalStore } from "react";
import { type NoteOrder, isNoteOrder } from "@/lib/note-order";

/** Where this device keeps each list's order: by folder, or "all" for all notes. */
const KEY = "memoca:note-order";

const listeners = new Set<() => void>();

/** Each list's order as set, where one is. */
function orders(): Record<string, NoteOrder> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
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

/**
 * How a list of notes is ordered on this device, and a way to set it: a
 * folder's list (by its id), or all notes (`null`), each its own. As it
 * always was (last changed first) until set. By hand only for a folder:
 * all notes, of every folder, have no one order to be placed in.
 *
 * Kept on this device only, as a view of the list; the order notes are
 * placed in by hand is the notes' own, and every device shares it.
 */
export function useNoteOrder(folderId: string | null): [NoteOrder, (order: NoteOrder) => void] {
  const scope = folderId ?? "all";
  const order = useSyncExternalStore(
    subscribe,
    () => orders()[scope] ?? "updated",
    () => "updated" as const,
  );
  const set = useCallback(
    (next: NoteOrder) => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ ...orders(), [scope]: next }));
      } catch {
        // Refused: it stays as it was.
      }
      for (const listener of listeners) listener();
    },
    [scope],
  );
  return [folderId === null && order === "manual" ? "updated" : order, set];
}
