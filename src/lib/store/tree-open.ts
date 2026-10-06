"use client";

import { create } from "zustand";

/** Where this device keeps which folders are open. */
const KEY = "memoca:tree-open";

function load(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    // On the server, storage refused, or not ours: all closed.
    return new Set();
  }
}

function save(open: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...open]));
  } catch {
    // Refused: open for this session only.
  }
}

type TreeOpenStore = {
  open: Set<string>;
  toggle: (folderId: string) => void;
  /** Opens every one of them, those open already staying so. */
  expand: (folderIds: string[]) => void;
};

/**
 * The folders open in the sidebar's tree: one set for both trees (the
 * sidebar's, and the drawer's on a phone, made anew each time it opens), and
 * kept on this device, so a folder opened stays open, as in VS Code.
 */
export const useTreeOpen = create<TreeOpenStore>((set, get) => ({
  open: load(),
  toggle: (folderId) => {
    const next = new Set(get().open);
    if (next.has(folderId)) next.delete(folderId);
    else next.add(folderId);
    save(next);
    set({ open: next });
  },
  expand: (folderIds) => {
    const current = get().open;
    if (folderIds.every((id) => current.has(id))) return;
    const next = new Set([...current, ...folderIds]);
    save(next);
    set({ open: next });
  },
}));
