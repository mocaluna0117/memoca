"use client";

import { useConvex } from "convex/react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { watchVaultActivity } from "@/lib/vault/activity";
import { repairLocks, sealedNameFolders } from "@/lib/vault/reconcile";

import { useSync } from "@/components/providers/sync-provider";

/**
 * Owns the interactions that need both the vault and the server: locking a
 * folder, and finishing a cascade that an earlier session left half done.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const client = useConvex();
  const { engine, status } = useSync();
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



  // Puts right what earlier versions left behind: folder names they sealed,
  // plaintext notes and files inside locks, an unfinished unlock, Inbox's old
  // lock. Runs when the vault opens, when the network returns, when sync
  // settles, and when a sealed folder name arrives from another device.
  const sealedNames = useLiveQuery(async () => (await sealedNameFolders()).length, [], 0);
  const settled = status.state === "idle" && !status.catchingUp && status.pending === 0;
  const unreadableSeen = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const report = await repairLocks(client, engine());
      if (cancelled) return;
      if (report.inboxUnlocked) {
        toast("Inbox はロックできなくなったため、Inbox のロックを外しました。ロックしていたメモは、ロックされたままです。");
      }
      if (report.namesRestored > 0) {
        toast.success(`ロックしたフォルダの名前を、ロック中も表示されるようにしました（${report.namesRestored} 件）`);
      }
      if (report.unlockResumed) toast.success("フォルダのロックを外す処理を再開しました");
      if (report.notesLocked > 0) toast.success(`ロックが途中だったメモ ${report.notesLocked} 件をロックしました`);
      if (report.attachmentsLocked > 0) {
        toast.success(`ロックしたメモの添付ファイル ${report.attachmentsLocked} 件を暗号化しました`);
      }
      if (report.unreadable > unreadableSeen.current) {
        toast.warning(`この金庫の鍵では開けないメモが ${report.unreadable} 件あります`, {
          action: { label: "設定を開く", onClick: () => router.push("/app/settings") },
        });
      }
      unreadableSeen.current = Math.max(unreadableSeen.current, report.unreadable);
    };
    const later = settled ? setTimeout(() => void run(), 2_000) : null;
    const unsubscribe = vault.subscribe((unlocked) => unlocked && void run());
    const onOnline = () => void run();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      if (later) clearTimeout(later);
      unsubscribe();
      window.removeEventListener("online", onOnline);
    };
  }, [client, engine, router, settled, sealedNames]);

  return (
    <>
      <AppShell>{children}</AppShell>
      <CommandPalette />
      <PwaPrompts />
      <VaultRecordSync />
      <VaultDialog />
    </>
  );
}
