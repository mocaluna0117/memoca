"use client";

import { create } from "zustand";

/** Folders whose lock is being put on or taken off right now, on this device. */
export const useLockProgress = create<{
  busy: ReadonlySet<string>;
  start: (folderId: string) => void;
  end: (folderId: string) => void;
}>((set) => ({
  busy: new Set(),
  start: (folderId) => set((state) => ({ busy: new Set(state.busy).add(folderId) })),
  end: (folderId) =>
    set((state) => {
      const busy = new Set(state.busy);
      busy.delete(folderId);
      return { busy };
    }),
}));
