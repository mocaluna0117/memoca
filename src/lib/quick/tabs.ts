"use client";

import * as Y from "yjs";
import type { SavedAs } from "@/lib/quick/draft";
import { createNote } from "@/lib/sync/mutations";

/**
 * A quick note's tab, as the account's: a note of its own (its id the
 * tab's, lib/quick/draft newTabId), synced as any note is, so that every
 * device has the same tabs and what is written in them, and kept out of
 * Memoca's own lists (lib/quick/todo-id isHiddenNote). What it was last
 * saved as is kept in it too (SAVED), the same on every device.
 */

/** The map, in a tab's document, of what it was last saved as. */
const SAVED = "quickSaved";

/** Makes a tab's note: at the top level, with no title, a quick note's. */
export async function makeTabNote(noteId: string): Promise<void> {
  await createNote({ folderId: null, topLevel: true, title: "", kind: "quick", noteId });
}

/** What a tab was last saved as, if it has been: saved again, that note is written over. */
export function readSaved(doc: Y.Doc): SavedAs | null {
  const saved = doc.getMap(SAVED).get("saved") as SavedAs | undefined;
  return saved && typeof saved.noteId === "string" ? saved : null;
}

/** Keeps what a tab was saved as, in its document: every device has it. */
export function writeSaved(doc: Y.Doc, saved: SavedAs): void {
  doc.getMap(SAVED).set("saved", saved);
}

/** Calls `told` whenever what a tab was saved as changes (here, or on another device). */
export function onSavedChange(doc: Y.Doc, told: () => void): () => void {
  const map = doc.getMap(SAVED);
  map.observe(told);
  return () => map.unobserve(told);
}
