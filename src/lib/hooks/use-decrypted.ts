"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ctx } from "@/lib/crypto/context";
import { open } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import type { Folder, Note } from "@/lib/types";

/** Tracks whether the vault is currently open, for conditional rendering. */
export function useVaultUnlocked(): boolean {
  return useSyncExternalStore(
    (listener) => vault.subscribe(() => listener()),
    () => vault.isUnlocked,
    () => false,
  );
}

/** What a locked note is called while its title cannot be read. */
export const LOCKED_LABEL = "ロックされたメモ";
const LOCKED_FOLDER_LABEL = "ロックされたフォルダ";

/** A locked note's title, decrypted: the vault has to be open. */
export async function decryptTitle(note: Note): Promise<string> {
  const noteKey = await vault.noteKey(note.noteId, note.keyEpoch, note.wrappedKey!);
  const plain = await open(
    noteKey,
    new Uint8Array(note.titleSealed!.ct),
    new Uint8Array(note.titleSealed!.iv),
    ctx.noteTitle(note.noteId, note.keyEpoch),
  );
  return new TextDecoder().decode(plain);
}

/**
 * The titles of a list's locked notes, decrypted while the vault is open,
 * by note: for ordering the list by name, which each row's own title
 * ({@link useNoteTitle}) comes too late for. Only when `enabled`; a note's
 * title that cannot be read is missing, and so is every one with the vault
 * closed. Held by this list only, and gone with it.
 */
export function useLockedTitles(notes: Note[], enabled: boolean): ReadonlyMap<string, string> {
  const unlocked = useVaultUnlocked();
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = enabled && unlocked;
  // What to decrypt: each locked note's title, as it now is.
  const sealed = wanted
    ? notes.filter((note) => note.locked && note.wrappedKey && note.titleSealed)
    : [];
  const keys = sealed.map((note) => `${note.noteId}:${note.keyEpoch}:${note.ts.title.t}`).join(" ");

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void (async () => {
      const found = new Map<string, string>();
      for (const note of sealed) {
        try {
          found.set(note.noteId, await decryptTitle(note));
        } catch {
          // The vault closed, or the title is unreadable: left out.
        }
      }
      if (!cancelled) setTitles(found);
    })();
    return () => {
      cancelled = true;
    };
    // `keys` stands for the notes it reads: the list object itself changes
    // with every unrelated live-query emission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, wanted]);

  return wanted ? titles : EMPTY_TITLES;
}

const EMPTY_TITLES: ReadonlyMap<string, string> = new Map();

/**
 * A note's title, decrypted only while the vault is open.
 *
 * The placeholder is computed during render, so a locked note never flashes
 * blank; the effect exists only for the asynchronous decryption, and its result
 * is tagged with the note and epoch it belongs to so a stale answer arriving
 * late cannot be shown against the wrong note.
 */
export function useNoteTitle(note: Note | null | undefined): string {
  const unlocked = useVaultUnlocked();
  const [decrypted, setDecrypted] = useState<{ key: string; value: string } | null>(null);

  const key = note ? `${note.noteId}:${note.keyEpoch}:${note.ts.title.t}` : "";
  const needsDecrypt = Boolean(note?.locked && unlocked && note.wrappedKey && note.titleSealed);

  useEffect(() => {
    if (!needsDecrypt || !note) return;
    let cancelled = false;
    void (async () => {
      try {
        const value = await decryptTitle(note);
        if (!cancelled) setDecrypted({ key, value });
      } catch {
        // Leave the placeholder in place; the vault may have closed mid-flight.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `key` already encodes the note, its epoch and its title stamp, so adding
    // the note object itself would re-run this on every unrelated live-query
    // emission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needsDecrypt]);

  return useMemo(() => {
    if (!note) return "";
    if (!note.locked) return note.title ?? "";
    if (needsDecrypt && decrypted?.key === key) return decrypted.value;
    return LOCKED_LABEL;
  }, [note, needsDecrypt, decrypted, key]);
}

export function useFolderName(folder: Folder | null | undefined): string {
  const unlocked = useVaultUnlocked();
  const [decrypted, setDecrypted] = useState<{ key: string; value: string } | null>(null);

  const key = folder ? `${folder.folderId}:${folder.ts.name.t}` : "";
  // Folder names are plaintext now; only a name an earlier version sealed
  // needs opening, until it is moved back to plaintext.
  const needsDecrypt = Boolean(folder && folder.name === null && unlocked && folder.nameSealed);

  useEffect(() => {
    if (!needsDecrypt || !folder) return;
    let cancelled = false;
    void vault
      .openFolderName(folder.folderId, folder.nameSealed!)
      .then((value) => {
        if (!cancelled) setDecrypted({ key, value });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // See the note in useNoteTitle: `key` covers everything that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needsDecrypt]);

  return useMemo(() => {
    if (!folder) return "";
    if (folder.name !== null) return folder.name;
    if (needsDecrypt && decrypted?.key === key) return decrypted.value;
    return folder.nameSealed ? LOCKED_FOLDER_LABEL : "";
  }, [folder, needsDecrypt, decrypted, key]);
}
