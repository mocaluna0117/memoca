"use client";

import { useEffect, useState } from "react";
import { ctx } from "@/lib/crypto/context";
import { open } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import type { Folder, Note } from "@/lib/types";

/** Tracks whether the vault is currently open, for conditional rendering. */
export function useVaultUnlocked(): boolean {
  const [unlocked, setUnlocked] = useState(vault.isUnlocked);
  useEffect(() => vault.subscribe(setUnlocked), []);
  return unlocked;
}

const LOCKED_LABEL = "🔒 ロック中のメモ";
const LOCKED_FOLDER_LABEL = "🔒 ロック中のフォルダ";

/**
 * A note's title, decrypted only while the vault is open. Locked notes show a
 * placeholder rather than an empty row, so the list still makes sense at a
 * glance without exposing anything.
 */
export function useNoteTitle(note: Note | undefined): string {
  const unlocked = useVaultUnlocked();
  const [title, setTitle] = useState<string>(() => note?.title ?? "");

  useEffect(() => {
    let cancelled = false;
    if (!note) {
      setTitle("");
      return;
    }
    if (!note.locked) {
      setTitle(note.title ?? "");
      return;
    }
    if (!unlocked || !note.wrappedKey || !note.titleSealed) {
      setTitle(LOCKED_LABEL);
      return;
    }
    void (async () => {
      try {
        const key = await vault.noteKey(note.noteId, note.keyEpoch, note.wrappedKey!);
        const plain = await open(
          key,
          new Uint8Array(note.titleSealed!.ct),
          new Uint8Array(note.titleSealed!.iv),
          ctx.noteTitle(note.noteId, note.keyEpoch),
        );
        if (!cancelled) setTitle(new TextDecoder().decode(plain));
      } catch {
        if (!cancelled) setTitle(LOCKED_LABEL);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [note?.noteId, note?.locked, note?.title, note?.keyEpoch, unlocked]);

  return title;
}

export function useFolderName(folder: Folder | undefined): string {
  const unlocked = useVaultUnlocked();
  const [name, setName] = useState<string>(() => folder?.name ?? "");

  useEffect(() => {
    let cancelled = false;
    if (!folder) {
      setName("");
      return;
    }
    if (!folder.locked) {
      setName(folder.name ?? "");
      return;
    }
    if (!unlocked || !folder.nameSealed) {
      setName(LOCKED_FOLDER_LABEL);
      return;
    }
    void vault
      .openFolderName(folder.folderId, folder.nameSealed)
      .then((value) => !cancelled && setName(value))
      .catch(() => !cancelled && setName(LOCKED_FOLDER_LABEL));
    return () => {
      cancelled = true;
    };
  }, [folder?.folderId, folder?.locked, folder?.name, unlocked]);

  return name;
}
