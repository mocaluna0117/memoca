"use client";

import { create } from "zustand";

type Selection = { folderId: string | null; noteId: string | null };

type SelectionStore = Selection & {
  /** Applies a selection, ignoring one that is already current. */
  apply: (next: Selection) => void;
};

/**
 * The selected folder and note, held in state rather than read back from the
 * URL.
 *
 * The URL is still the record of where you are, and is kept in step, but it
 * cannot be the source of truth: `useSearchParams` updates a tick after
 * `history.pushState`, and in that gap the previous note's title field is still
 * mounted and accepting keystrokes that are then thrown away when the pane
 * switches. Someone who taps "new note" and starts typing immediately lost
 * what they typed.
 */
export const useSelectionStore = create<SelectionStore>((set, get) => ({
  folderId: null,
  noteId: null,
  apply: (next) => {
    const current = get();
    if (current.folderId === next.folderId && current.noteId === next.noteId) return;
    set({ folderId: next.folderId, noteId: next.noteId });
  },
}));
