"use client";

import { useConvex } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSync, useSyncStatus } from "@/components/providers/sync-provider";
import { vault } from "@/lib/crypto/vault";
import type { SyncStatus } from "@/lib/sync/engine";
import { repairLocks, sealedNameFolders } from "@/lib/vault/reconcile";
import { repairDue } from "@/lib/vault/repair-schedule";

/** How long sync is given to settle further before the pass runs. */
const REPAIR_AFTER_MS = 2_000;

/**
 * Puts right what earlier versions left behind: folder names they sealed,
 * plaintext notes and files inside locks, an unfinished unlock, Inbox's old
 * lock. Runs when the vault opens, when the network returns, when a catch-up
 * with the server is over, when sync settles (at most every ten minutes: it
 * settles again after every flush of a note being typed in), and when a
 * sealed folder name arrives from another device.
 *
 * A component of its own, showing nothing: it follows the sync status, and
 * nothing of the shell around it is drawn again with each change of that.
 */
export function LockRepairs() {
  const client = useConvex();
  const { engine } = useSync();
  const router = useRouter();
  const status = useSyncStatus();
  const sealedNames = useLiveQuery(async () => (await sealedNameFolders()).length, [], 0);
  const mounted = useRef(false);
  const unreadableSeen = useRef(0);
  // Said once per session: the repair pass runs often.
  const copiesWarned = useRef(false);
  const plainCopiesWarned = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const report = await repairLocks(client, engine());
    if (!mounted.current) return;
    if (report.inboxUnlocked) {
      toast(
        "Inbox はロックできなくなったため、Inbox のロックを外しました。ロックしていたメモは、ロックされたままです。",
      );
    }
    if (report.namesRestored > 0) {
      toast.success(
        `ロックしたフォルダの名前を、ロック中も表示されるようにしました（${report.namesRestored} 件）`,
      );
    }
    if (report.unlockResumed) toast.success("フォルダのロックを外す処理を再開しました");
    if (report.notesLocked > 0)
      toast.success(`ロックが途中だったメモ ${report.notesLocked} 件をロックしました`);
    if (report.attachmentsLocked > 0) {
      toast.success(`ロックしたメモの添付ファイル ${report.attachmentsLocked} 件を暗号化しました`);
    }
    if (report.copiesLocked > 0) {
      toast.success(
        `ほかのメモからロックしたメモにコピーされていた画像 ${report.copiesLocked} 件を、そのメモ用に暗号化しました`,
      );
    }
    if (report.copiesTooLarge > 0 && !copiesWarned.current) {
      copiesWarned.current = true;
      toast.warning(
        `ロックしたメモに、ほかのメモからコピーした画像が ${report.copiesTooLarge} 件あり、容量が足りないため暗号化できていません。不要なファイルを削除すると、自動で暗号化します。`,
        { action: { label: "設定を開く", onClick: () => router.push("/app/settings") } },
      );
    }
    if (report.plainCopiesTooLarge > 0 && !plainCopiesWarned.current) {
      plainCopiesWarned.current = true;
      toast.warning(
        `ロックしたメモからコピーした画像が ${report.plainCopiesTooLarge} 件あり、容量が足りないため、コピー先のメモに保存できていません。不要なファイルを削除すると、自動で保存します。`,
        { action: { label: "設定を開く", onClick: () => router.push("/app/settings") } },
      );
    }
    if (report.unreadable > unreadableSeen.current) {
      toast.warning(`この金庫の鍵では開けないメモが ${report.unreadable} 件あります`, {
        action: { label: "設定を開く", onClick: () => router.push("/app/settings") },
      });
    }
    unreadableSeen.current = Math.max(unreadableSeen.current, report.unreadable);
  }, [client, engine, router]);

  // On a change of the sync status: a pass two seconds on, when sync settling
  // or the end of a catch-up calls for one (repairDue). A pass called for
  // already is left to run as it was: the status changes again within the
  // second as a sync ends, and a pass put off by that would be lost to the
  // ten-minute limit.
  const prevStatus = useRef<SyncStatus | null>(null);
  const lastSettledRunAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const due = repairDue(prevStatus.current, status, lastSettledRunAt.current, Date.now());
    prevStatus.current = status;
    if (!due) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      lastSettledRunAt.current = Date.now();
      void run();
    }, REPAIR_AFTER_MS);
  }, [status, run]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // When the vault opens, when the network returns, and when the sealed
  // folder names change after this was mounted: one arrived from another
  // device, to be unsealed, or went.
  const sealedSeen = useRef(sealedNames);
  useEffect(() => {
    if (sealedNames !== sealedSeen.current) {
      sealedSeen.current = sealedNames;
      void run();
    }
    const unsubscribe = vault.subscribe((unlocked) => unlocked && void run());
    const onOnline = () => void run();
    window.addEventListener("online", onOnline);
    return () => {
      unsubscribe();
      window.removeEventListener("online", onOnline);
    };
  }, [sealedNames, run]);

  return null;
}
