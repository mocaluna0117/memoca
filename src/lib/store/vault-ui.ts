"use client";

import { create } from "zustand";

type Pending = {
  resolve: (unlocked: boolean) => void;
};

type VaultUiState = {
  open: boolean;
  mode: "unlock" | "setup";
  pending: Pending | null;
  /** Opens the unlock sheet and resolves once the vault is open or dismissed. */
  requestUnlock: () => Promise<boolean>;
  openSetup: () => void;
  close: (unlocked: boolean) => void;
};

/**
 * One place to ask "I need the vault open". Any screen can await it, and the
 * dialog decides whether that means Face ID, a password or first-time setup.
 */
export const useVaultUi = create<VaultUiState>((set, get) => ({
  open: false,
  mode: "unlock",
  pending: null,
  requestUnlock: () =>
    new Promise<boolean>((resolve) => {
      const current = get().pending;
      if (current) current.resolve(false);
      set({ open: true, mode: "unlock", pending: { resolve } });
    }),
  openSetup: () => set({ open: true, mode: "setup", pending: null }),
  close: (unlocked) => {
    get().pending?.resolve(unlocked);
    set({ open: false, pending: null });
  },
}));
