"use client";

import { useConvex } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSyncEngine, useSyncStatus } from "@/components/providers/sync-provider";
import { vault } from "@/lib/crypto/vault";
import type { SyncStatus } from "@/lib/sync/engine";
import { repairLocks, sealedNameFolders } from "@/lib/vault/reconcile";
import { NO_PASS_YET, type RepairSchedule, repairDue, settled } from "@/lib/vault/repair-schedule";

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
  const engine = useSyncEngine();
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

  const pass = useCallback(async () => {
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

  // One pass at a time: asked for again meanwhile, it runs once more after,
  // rather than joining the pass under way and showing its report again.
  const inFlight = useRef(false);
  const again = useRef(false);
  const run = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        await pass();
      } while (again.current && mounted.current);
    } finally {
      inFlight.current = false;
    }
  }, [pass]);

  // On a change of the sync status: a pass two seconds on, when sync settling
  // or the end of a catch-up calls for one (repairDue). A pass called for
  // already is left to run as it was: the status changes again within the
  // second as a sync ends. It runs only if sync is still settled by then:
  // typing resumed, it is left to the next settling (a catch-up's pass stays
  // owed, so that one is not lost to the ten-minute limit).
  const latest = useRef(status);
  const prevStatus = useRef<SyncStatus | null>(null);
  const schedule = useRef<RepairSchedule>(NO_PASS_YET);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    latest.current = status;
    const due = repairDue(prevStatus.current, status, schedule.current, Date.now());
    prevStatus.current = status;
    schedule.current = due.schedule;
    if (!due.run) return;
    const kind = due.run;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!settled(latest.current)) {
        if (kind === "catchUp") schedule.current = { ...schedule.current, catchUpOwed: true };
        return;
      }
      schedule.current = { ...schedule.current, lastSettledRunAt: Date.now() };
      void run();
    }, REPAIR_AFTER_MS);
  }, [status, run]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      // Mounted again (development's StrictMode): the status is seen afresh.
      prevStatus.current = null;
    },
    [],
  );

  // When the vault opens, when the network returns, and when a sealed folder
  // name arrives from another device after this was mounted, to be unsealed
  // (fewer of them is the pass's own doing).
  const sealedSeen = useRef(sealedNames);
  useEffect(() => {
    if (sealedNames > sealedSeen.current) void run();
    sealedSeen.current = sealedNames;
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
