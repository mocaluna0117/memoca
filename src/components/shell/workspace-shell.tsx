"use client";

import { useConvex } from "convex/react";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CommandPalette } from "@/components/search/command-palette";
import { AppShell } from "@/components/shell/app-shell";
import { PwaPrompts } from "@/components/shell/pwa-prompts";
import { VaultDialog } from "@/components/vault/vault-dialog";
import { VaultRecordSync } from "@/components/vault/vault-record-sync";
import { recoveryKeyState } from "@/components/vault/recovery-settings";
import { getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { useVaultRecord } from "@/lib/vault/record";
import { vault } from "@/lib/crypto/vault";
import { revokeResolvedUrls } from "@/lib/media/attachments";
import { flushAll } from "@/lib/sync/docs";
import { useLiveQuery } from "dexie-react-hooks";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { watchVaultActivity } from "@/lib/vault/activity";
import { sealedNameFolders, unsealFolderNames } from "@/lib/vault/reconcile";
import { requestVault } from "@/lib/store/vault-gate";
import type { FolderNode } from "@/lib/types";
import { resumeCascades, setFolderLocked } from "@/lib/vault/actions";

/**
 * Owns the interactions that need both the vault and the server: locking a
 * folder, and finishing a cascade that an earlier session left half done.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const client = useConvex();
  const router = useRouter();
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

  // The vault closes after a period of no use, counted from the last
  // activity, and says so when it does.
  useEffect(() => watchVaultActivity(), []);
  useEffect(
    () =>
      vault.onClosed((reason) =>
        toast(
          reason === "idle"
            ? `金庫を閉じました（${vault.autoLockMinutes} 分間操作がなかったため）`
            : "金庫を閉じました",
        ),
      ),
    [],
  );

  // Every recovery key shown before the display fix is unusable, so the owner
  // of such a vault is asked for a new one when they open it, at most daily.
  useEffect(
    () =>
      vault.subscribe((unlocked) => {
        const record = useVaultRecord.getState().record;
        if (!unlocked || !record) return;
        const state = recoveryKeyState(record);
        if (state === "ok") return;
        void (async () => {
          const last = await getMeta<number>(META.recoveryNudgeAt, 0);
          if (Date.now() - last < 24 * 60 * 60 * 1000) return;
          await setMeta(META.recoveryNudgeAt, Date.now());
          toast(
            state === "legacy"
              ? "リカバリーキーを作り直してください"
              : "リカバリーキーの保管を確認してください",
            {
              duration: 10_000,
              action: { label: "設定を開く", onClick: () => router.push("/app/settings") },
            },
          );
        })();
      }),
    [router],
  );

  // A phone can suspend or kill a backgrounded app without warning. Writing
  // buffered edits as soon as the app is hidden means none are lost, and for
  // a locked note they are written while the vault can still encrypt them.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flushAll();
    };
    const onPageHide = () => void flushAll();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  // Folder names an earlier version sealed become plaintext again the moment
  // the vault is open, and also when such a folder arrives from a device that
  // still runs that version.
  const sealedNames = useLiveQuery(async () => (await sealedNameFolders()).length, [], 0);
  const unlockedNow = useVaultUnlocked();
  useEffect(() => {
    if (!unlockedNow || sealedNames === 0) return;
    void unsealFolderNames().then((restored) => {
      if (restored > 0) {
        toast.success(`ロックしたフォルダの名前を、ロック中も表示されるようにしました（${restored} 件）`);
      }
    });
  }, [unlockedNow, sealedNames]);

  // A folder can be marked locked while some of its notes are still plaintext,
  // for example if the tab closed mid-cascade. Finish the job as soon as the
  // vault is open again.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!vault.isUnlocked) return;
      const release = vault.hold();
      try {
        const repaired = await resumeCascades(client);
        if (!cancelled && repaired > 0) {
          toast.success(`ロックが途中だったメモ ${repaired} 件をロックしました`);
        }
      } finally {
        release();
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
    async (folder: FolderNode, returnFocus?: HTMLElement | null) => {
      const locking = !folder.locked;
      const name = folder.name ?? "ロックされたフォルダ";
      // The prompt states what is about to happen and asks for a yes, with
      // the vault open or not. Closing it means "not now"; it never leads to
      // creating a vault unless the server says there is none.
      const answer = await requestVault(
        locking
          ? { kind: "lockFolder", folderId: folder.folderId, name }
          : { kind: "unlockFolder", folderId: folder.folderId, name },
        { returnFocus },
      );
      if (!answer.ok) return;

      const doing = locking
        ? `フォルダ「${name}」をロックしています…`
        : `フォルダ「${name}」のロックを外しています…`;
      const toastId = toast.loading(doing);
      // Closing the vault half way would leave the folder half locked.
      const release = vault.hold();
      try {
        const outcome = await setFolderLocked(client, folder.folderId, locking, (p) => {
          if (p.total > 1) toast.loading(`${doing}（${p.done} / ${p.total}）`, { id: toastId });
        });
        if (outcome.status === "ok") {
          toast.success(
            locking ? `フォルダ「${name}」をロックしました` : `フォルダ「${name}」のロックを外しました`,
            { id: toastId },
          );
        } else {
          toast.error(
            outcome.status === "skipped" && outcome.reason === "behind"
              ? "同期が終わってからもう一度お試しください。"
              : locking
                ? "ロックできませんでした。もう一度お試しください。"
                : "ロックを外せませんでした。もう一度お試しください。",
            { id: toastId },
          );
        }
      } catch {
        // A failure part way must not leave the "in progress" message spinning.
        toast.error(
          locking
            ? "ロックできませんでした。インターネット接続を確認して、もう一度お試しください。"
            : "ロックを外せませんでした。インターネット接続を確認して、もう一度お試しください。",
          { id: toastId },
        );
      } finally {
        release();
      }
    },
    [client],
  );

  return (
    <>
      <AppShell onRequestFolderLock={onRequestFolderLock}>{children}</AppShell>
      <CommandPalette />
      <PwaPrompts />
      <VaultRecordSync />
      <VaultDialog />
    </>
  );
}
