"use client";

import { useConvex } from "convex/react";
import { useMemo } from "react";
import { db } from "@/lib/db";
import { useFolders } from "@/lib/hooks/data";
import { createNote, moveFolder, moveNote } from "@/lib/sync/mutations";
import { subtreeIds } from "@/lib/tree";
import { lockCoverage, planFolderLock } from "@/lib/vault/model";
import { toast } from "sonner";
import { useSync } from "@/components/providers/sync-provider";
import { vault } from "@/lib/crypto/vault";
import { requestVault } from "@/lib/store/vault-gate";
import { useLockProgress } from "@/lib/store/lock-progress";
import type { Folder, Note } from "@/lib/types";
import {
  type CascadeResult,
  type LockReport,
  changeNote,
  lockFolder,
  resumeUnlockJob,
  unlockFolder,
} from "@/lib/vault/cascade";

const OFFLINE_LOCK = "オフラインのため、いまはロックできません。インターネットに接続してから、もう一度お試しください。";
const OFFLINE_UNLOCK =
  "オフラインのため、いまはロックを外せません。インターネットに接続してから、もう一度お試しください。";
const INTERRUPTED = "金庫が閉じたため中断しました。金庫を開くと続きから再開します。";

/**
 * Added to a lock's message when images copied in from other notes are still
 * readable where they are: the lock went through, but not all of it is sealed.
 */
export function copiesLeftNotice(count: number, oneNote: boolean): string {
  return `ただし、ほかのメモからコピーした画像 ${count} 件は、まだ${oneNote ? "このメモ用に" : ""}暗号化できていません。容量やネットワークが整いしだい、自動で暗号化します。`;
}

/** Says a lock is done, and what it could not seal yet. */
function sayLocked(message: string, report: LockReport, oneNote: boolean, id?: string | number) {
  const options = id === undefined ? {} : { id };
  if (report.copiesLeft > 0) {
    toast.warning(`${message}。${copiesLeftNotice(report.copiesLeft, oneNote)}`, options);
  } else {
    toast.success(message, options);
  }
}

const moveFailure = (cause: unknown) =>
  cause instanceof Error && cause.message === "vaultClosed"
    ? "金庫が閉じたため、移動しませんでした。もう一度お試しください。"
    : "オフラインのため、いまは移動してロックできません。インターネットに接続してから、もう一度お試しください。";

/**
 * Locking and unlocking notes and folders, from any menu.
 *
 * Each action asks the prompt first, straight from the tap (so Face ID can
 * start inside it), then does the work with the vault held open, then says
 * exactly what happened, including when only part of it could be done.
 */
export function useLockActions() {
  const client = useConvex();
  const { engine } = useSync();
  const start = useLockProgress((s) => s.start);
  const end = useLockProgress((s) => s.end);
  // Known before any tap, so the prompt can be asked for inside it.
  const folders = useFolders();

  return useMemo(() => {
    const coverage = lockCoverage(folders);
    const nameOf = (folderId: string | null | undefined) =>
      folders.find((f) => f.folderId === folderId)?.name ?? "ロックされたフォルダ";
    /** The locked folder a place is under, if any. */
    const cover = (folderId: string | null) => (folderId !== null ? (coverage.get(folderId) ?? null) : null);

    /** Locks notes one by one; true only if every one of them is locked. */
    const lockAll = async (noteIds: string[], report: LockReport) => {
      const release = vault.hold();
      try {
        for (const noteId of noteIds) {
          if ((await changeNote(client, engine(), noteId, "lock", "folder", report)) !== null) return false;
        }
        return true;
      } finally {
        release();
      }
    };

    const reportLock = (name: string, result: CascadeResult, id: string | number) => {
      if (result.failed) {
        toast.error("ロックできませんでした。もう一度お試しください。", { id });
      } else if (result.aborted) {
        toast.error(result.aborted === "offline" ? OFFLINE_LOCK : INTERRUPTED, { id });
      } else if (result.pending.length > 0) {
        toast.warning(
          `${result.done} 件をロックしました。残りの ${result.pending.length} 件は、同期が終わりしだい自動でロックします。`,
          { id },
        );
      } else {
        sayLocked(
          result.total > 0
            ? `フォルダ「${name}」をロックしました（メモ ${result.total} 件）`
            : `フォルダ「${name}」をロックしました`,
          { copiesLeft: result.copiesLeft ?? 0 },
          false,
          id,
        );
      }
    };

    const reportUnlock = (name: string, result: CascadeResult, id: string | number) => {
      const kept = result.kept
        ? { description: `個別にロックしたメモなど ${result.kept} 件は、ロックしたままです。` }
        : {};
      if (result.failed) {
        toast.error("ロックを外せませんでした。もう一度お試しください。", { id });
      } else if (result.aborted) {
        toast.error(result.aborted === "offline" ? OFFLINE_UNLOCK : INTERRUPTED, { id });
      } else if (result.pending.length > 0) {
        toast.warning(
          `${result.pending.length} 件のメモのロックを外せませんでした。ロックしたままになっています。`,
          {
            id,
            action: {
              label: "続ける",
              onClick: () => {
                void resumeUnlockJob(client, engine()).then((again) => {
                  if (again && again.pending.length === 0) toast.success(`フォルダ「${name}」のロックを外しました`);
                });
              },
            },
          },
        );
      } else {
        toast.success(
          result.total > 0
            ? `フォルダ「${name}」のロックを外しました（メモ ${result.total} 件）`
            : `フォルダ「${name}」のロックを外しました`,
          { id, ...kept },
        );
      }
    };

    return {
      /**
       * A new note in a folder. In a locked folder it is encrypted from the
       * start, which needs the vault, so the prompt comes first. Returns null
       * when the prompt was closed.
       */
      createNoteIn: async (folderId: string | null): Promise<string | null> => {
        const covering = cover(folderId);
        if (covering && !vault.isUnlocked) {
          const answer = await requestVault(
            { kind: "createInLocked", name: nameOf(folderId) },
            { gesture: true },
          );
          if (!answer.ok) return null;
        }
        try {
          return await createNote({ folderId });
        } catch {
          toast.error("メモを作成できませんでした。金庫を開いてから、もう一度お試しください。");
          return null;
        }
      },

      /**
       * Moves a note. Into a locked folder, a plaintext note is locked first
       * and moved only once that has worked, so it is never plaintext there.
       */
      moveNoteTo: async (note: Note, folderId: string | null, returnFocus?: HTMLElement | null) => {
        const into = cover(folderId);
        const from = cover(note.folderId);
        if (!into || note.locked) {
          await moveNote(note.noteId, folderId);
          toast.success(note.locked && from && !into ? "移動しました。メモのロックはそのままです。" : "移動しました");
          return;
        }
        const answer = await requestVault({ kind: "moveIntoLocked", name: nameOf(folderId) }, { returnFocus });
        if (!answer.ok) return;
        const report: LockReport = { copiesLeft: 0 };
        try {
          if (!(await lockAll([note.noteId], report))) {
            toast.error("ロックできなかったメモがあるため、移動しませんでした。もう一度お試しください。");
            return;
          }
        } catch (cause) {
          toast.error(moveFailure(cause));
          return;
        }
        await moveNote(note.noteId, folderId);
        sayLocked("移動してロックしました", report, true);
      },

      /**
       * Moves a folder. Into a locked folder, its plaintext notes are locked
       * first, and the folder moves only once all of them are.
       */
      moveFolderTo: async (folderId: string, parentId: string | null, sortKey?: string) => {
        const into = cover(parentId);
        const from = cover(folderId);
        if (!into || into === from) {
          await moveFolder(folderId, parentId, sortKey);
          if (from && !into) {
            const inside = new Set(subtreeIds(folders, folderId));
            const lockedInside = await db()
              .notes.filter((n) => n.locked && n.folderId !== null && inside.has(n.folderId))
              .count();
            if (lockedInside > 0) toast("移動しました。中のメモはロックされたままです。");
          }
          return;
        }
        const plan = planFolderLock(folderId, await db().folders.toArray(), await db().notes.toArray());
        const report: LockReport = { copiesLeft: 0 };
        if (plan.length > 0) {
          const answer = await requestVault({
            kind: "moveIntoLocked",
            name: nameOf(parentId),
            folder: nameOf(folderId),
            count: plan.length,
          });
          if (!answer.ok) return;
          try {
            if (!(await lockAll(plan, report))) {
              toast.error("ロックできなかったメモがあるため、移動しませんでした。もう一度お試しください。");
              return;
            }
          } catch (cause) {
            toast.error(moveFailure(cause));
            return;
          }
        }
        await moveFolder(folderId, parentId, sortKey);
        if (plan.length > 0) sayLocked("移動してロックしました", report, false);
      },

      toggleFolderLock: async (folder: Folder, returnFocus?: HTMLElement | null) => {
        const locking = !folder.locked;
        const name = folder.name ?? "ロックされたフォルダ";
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
        const id = toast.loading(doing);
        start(folder.folderId);
        const progress = (done: number, total: number) => {
          if (total > 1) toast.loading(`${doing}（${done} / ${total}）`, { id });
        };
        try {
          const result = locking
            ? await lockFolder(client, engine(), folder.folderId, progress)
            : await unlockFolder(client, engine(), folder.folderId, progress);
          (locking ? reportLock : reportUnlock)(name, result, id);
        } catch {
          // Nothing may leave the "in progress" message spinning.
          toast.error(
            locking
              ? "ロックできませんでした。インターネット接続を確認して、もう一度お試しください。"
              : "ロックを外せませんでした。インターネット接続を確認して、もう一度お試しください。",
            { id },
          );
        } finally {
          end(folder.folderId);
        }
      },

      toggleNoteLock: async (note: Note, title: string | null, returnFocus?: HTMLElement | null) => {
        const removing = note.locked;
        // Asked straight from the tap, with nothing awaited first, so the
        // prompt can start Face ID / Touch ID inside it.
        const answer = await requestVault(
          removing ? { kind: "unlockNote", title } : { kind: "lockNote", title },
          { gesture: true, returnFocus },
        );
        if (!answer.ok) return;
        const release = vault.hold();
        const report: LockReport = { copiesLeft: 0 };
        try {
          const reason = await changeNote(
            client,
            engine(),
            note.noteId,
            removing ? "unlock" : "lock",
            "note",
            report,
          );
          if (reason === null) {
            // Locked, but an image copied in from another note could not be
            // given its own encrypted copy yet: say so, not just "done".
            sayLocked(removing ? "メモのロックを外しました" : "メモをロックしました", report, true);
          } else if (reason === "behind" || reason === "unsent") {
            toast.error(
              removing
                ? "同期が終わらないため、ロックを外せませんでした。インターネット接続を確認して、もう一度お試しください。"
                : "同期が終わらないため、ロックできませんでした。インターネット接続を確認して、もう一度お試しください。",
            );
          } else {
            toast.error(
              removing
                ? "ロックを外せませんでした。もう一度お試しください。"
                : "ロックできませんでした。もう一度お試しください。",
            );
          }
        } catch (cause) {
          const offline = cause instanceof Error && cause.message === "offline";
          toast.error(
            offline
              ? removing
                ? OFFLINE_UNLOCK
                : OFFLINE_LOCK
              : cause instanceof Error && cause.message === "vaultClosed"
                ? "金庫が閉じたため中断しました。もう一度お試しください。"
                : removing
                  ? "ロックを外せませんでした。インターネット接続を確認して、もう一度お試しください。"
                  : "ロックできませんでした。インターネット接続を確認して、もう一度お試しください。",
          );
        } finally {
          release();
        }
      },
    };
  }, [client, engine, start, end, folders]);
}
