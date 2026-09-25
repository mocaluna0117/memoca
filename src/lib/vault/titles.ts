"use client";

import { useSyncExternalStore } from "react";
import { ctx } from "@/lib/crypto/context";
import { open } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import type { Note } from "@/lib/types";

/**
 * Locked notes' titles, opened in memory while the vault is open, so search
 * can find them. Nothing here is ever written to disk, and all of it is
 * dropped the moment the vault closes.
 */

/** Changes whenever the note, its key or its title does. */
export const titleKey = (note: Pick<Note, "noteId" | "keyEpoch" | "ts">) =>
  `${note.noteId}:${note.keyEpoch}:${note.ts.title.t}`;

const EMPTY: ReadonlyMap<string, string> = new Map();

const opened = new Map<string, string>();
/** Titles that could not be opened, so they are not tried on every change. */
const failed = new Set<string>();
let snapshot: ReadonlyMap<string, string> = EMPTY;
const listeners = new Set<() => void>();
/** Bumped when the vault closes, so a decryption still running is dropped. */
let generation = 0;
let watching = false;

function publish() {
  snapshot = opened.size > 0 ? new Map(opened) : EMPTY;
  for (const listener of listeners) listener();
}

function watchVault() {
  if (watching) return;
  watching = true;
  vault.subscribe((unlocked) => {
    if (unlocked) return;
    generation += 1;
    failed.clear();
    if (opened.size === 0) return;
    opened.clear();
    publish();
  });
}

const sealed = (note: Note) =>
  note.locked && !note.purged && Boolean(note.wrappedKey) && Boolean(note.titleSealed);

/**
 * Opens the titles of these locked notes that are not open yet, and forgets
 * any it holds for notes no longer in the list.
 */
export async function openTitles(notes: Note[]): Promise<void> {
  if (!vault.isUnlocked) return;
  watchVault();
  const started = generation;
  const wanted = notes.filter(sealed);
  const keys = new Set(wanted.map(titleKey));

  let changed = false;
  for (const key of opened.keys()) {
    if (!keys.has(key)) {
      opened.delete(key);
      changed = true;
    }
  }

  for (const note of wanted) {
    const key = titleKey(note);
    if (opened.has(key) || failed.has(key)) continue;
    try {
      const noteKey = await vault.noteKey(note.noteId, note.keyEpoch, note.wrappedKey!);
      const plain = await open(
        noteKey,
        new Uint8Array(note.titleSealed!.ct),
        new Uint8Array(note.titleSealed!.iv),
        ctx.noteTitle(note.noteId, note.keyEpoch),
      );
      if (generation !== started || !vault.isUnlocked) return;
      opened.set(key, new TextDecoder().decode(plain));
      changed = true;
    } catch {
      if (generation !== started || !vault.isUnlocked) return;
      failed.add(key);
    }
  }
  if (changed) publish();
}

/** The titles opened so far, keyed by {@link titleKey}. */
export const openedTitles = (): ReadonlyMap<string, string> => snapshot;

export function useOpenedTitles(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openedTitles,
    () => EMPTY,
  );
}
