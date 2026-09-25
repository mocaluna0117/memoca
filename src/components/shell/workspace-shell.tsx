"use client";

import { useConvex } from "convex/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CommandPalette } from "@/components/search/command-palette";
import { AppShell } from "@/components/shell/app-shell";
import { PwaPrompts } from "@/components/shell/pwa-prompts";
import { VaultDialog } from "@/components/vault/vault-dialog";
import { vault } from "@/lib/crypto/vault";
import { revokeResolvedUrls } from "@/lib/media/attachments";
import { useVaultUi } from "@/lib/store/vault-ui";
import type { FolderNode } from "@/lib/types";
import { resumeCascades, setFolderLocked } from "@/lib/vault/actions";

/**
 * Owns the interactions that need both the vault and the server: locking a
 * folder, and finishing a cascade that an earlier session left half done.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const client = useConvex();
  const requestUnlock = useVaultUi((s) => s.requestUnlock);
  const [, setUnlocked] = useState(vault.isUnlocked);

  useEffect(
    () =>
      vault.subscribe((unlocked) => {
        setUnlocked(unlocked);
        // Decrypted images live only as blob URLs in this tab; locking the
        // vault has to take them with it.
        if (!unlocked) revokeResolvedUrls();
      }),
    [],
  );

  // A folder can be marked locked while some of its notes are still plaintext,
  // for example if the tab closed mid-cascade. Finish the job as soon as the
  // vault is open again.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!vault.isUnlocked) return;
      const repaired = await resumeCascades(client);
      if (!cancelled && repaired > 0) {
        toast.success(`${repaired} 件のメモのロックを完了しました`);
      }
    };
    const unsubscribe = vault.subscribe((unlocked) => unlocked && void run());
    void run();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  const onRequestFolderLock = useCallback(
    async (folder: FolderNode) => {
      // Closing the prompt means "not now". The prompt itself offers to create
      // a vault when the server says there is none, so nothing opens here.
      const hasVault = vault.isUnlocked || (await requestUnlock());
      if (!hasVault) return;
      const target = !folder.locked;
      const toastId = toast.loading(
        target ? "フォルダをロックしています…" : "ロックを解除しています…",
      );
      const outcome = await setFolderLocked(client, folder.folderId, target, (p) => {
        if (p.total > 1) {
          toast.loading(`${p.done} / ${p.total} 件を処理中…`, { id: toastId });
        }
      });
      if (outcome.status === "ok") {
        toast.success(target ? "ロックしました" : "ロックを解除しました", { id: toastId });
      } else {
        toast.error(
          outcome.status === "skipped" && outcome.reason === "behind"
            ? "同期が終わってからもう一度お試しください。"
            : "処理できませんでした。",
          { id: toastId },
        );
      }
    },
    [client, requestUnlock],
  );

  return (
    <>
      <AppShell onRequestFolderLock={onRequestFolderLock}>{children}</AppShell>
      <CommandPalette />
      <PwaPrompts />
      <VaultDialog />
    </>
  );
}
