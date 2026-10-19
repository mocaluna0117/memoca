"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { OpenNoteFromQuickWindow, QuickNoteShortcut } from "@/components/notes/quick-entry";
import { CommandPalette } from "@/components/search/command-palette";
import { AppShell } from "@/components/shell/app-shell";
import { PwaPrompts } from "@/components/shell/pwa-prompts";
import { useShellRefresh } from "@/components/shell/shell-refresh";
import { WorkspaceDnd } from "@/components/shell/workspace-dnd";
import { LockRepairs } from "@/components/vault/lock-repairs";
import { VaultDialog } from "@/components/vault/vault-dialog";
import { VaultRecordSync } from "@/components/vault/vault-record-sync";
import { recoveryKeyState } from "@/components/vault/recovery-settings";
import { getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { useVaultRecord } from "@/lib/vault/record";
import { vault } from "@/lib/crypto/vault";
import { flushAll } from "@/lib/sync/docs";
import { watchVaultActivity } from "@/lib/vault/activity";
import { startImeTrace } from "@/lib/debug/ime-trace";
import { tidyYomi } from "@/lib/search/yomi";

/**
 * Owns the interactions that need both the vault and the server: locking a
 * folder, and finishing a cascade that an earlier session left half done.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const router = useRouter();

  // Kept hidden by the desktop shell: a new version loaded out of sight.
  useShellRefresh();

  // The vault closes after a period of no use, counted from the last
  // activity, and says so when it does.
  useEffect(() => watchVaultActivity(), []);
  // Temporary, in the Mac desktop app: ⌘⌥⇧I copies what the editor's input saw.
  useEffect(() => startImeTrace(() => toast.success("入力の記録をコピーしました")), []);
  // A reading dictionary kept on this device that is not to be kept goes.
  useEffect(() => void tidyYomi(), []);
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

  return (
    <>
      {/* One place for the drags of both the sidebar and the list: a note
          dragged onto a folder. */}
      <WorkspaceDnd>
        <AppShell>{children}</AppShell>
      </WorkspaceDnd>
      <CommandPalette />
      <QuickNoteShortcut />
      <OpenNoteFromQuickWindow />
      <PwaPrompts />
      <VaultRecordSync />
      {/* Follows the sync status, which changes with every flush of a note
          being typed in: a leaf of its own, so that nothing else here does. */}
      <LockRepairs />
      <VaultDialog />
    </>
  );
}
