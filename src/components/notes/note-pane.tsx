"use client";

import { useConvex } from "convex/react";
import {
  ArrowLeft,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useNote } from "@/lib/hooks/data";
import { useNoteTitle, useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { useVaultUi } from "@/lib/store/vault-ui";
import { renameNote, setNotePinned, setNoteTrashed } from "@/lib/sync/mutations";
import { lockNote, unlockNote } from "@/lib/vault/actions";
import { t } from "@/lib/i18n/ja";

// BlockNote touches the DOM on construction, so it never renders on the server.
const NoteEditor = dynamic(
  () => import("@/components/editor/note-editor").then((m) => m.NoteEditor),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-3 px-4 py-6 sm:px-10">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-full" />
      </div>
    ),
  },
);

export function NotePane({
  noteId,
  onBack,
}: {
  noteId: string;
  onBack: () => void;
}) {
  const client = useConvex();
  const note = useNote(noteId);
  const title = useNoteTitle(note);
  const unlocked = useVaultUnlocked();
  const requestUnlock = useVaultUi((s) => s.requestUnlock);
  const openSetup = useVaultUi((s) => s.openSetup);

  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(title), [title, noteId]);

  useEffect(() => {
    if (!note || draft === title) return;
    const handle = setTimeout(() => void renameNote(noteId, draft), 400);
    return () => clearTimeout(handle);
  }, [draft, title, noteId, note]);

  if (!note) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        メモが見つかりません
      </div>
    );
  }

  const toggleLock = async () => {
    setBusy(true);
    try {
      const ready = unlocked || (await requestUnlock());
      if (!ready) {
        openSetup();
        return;
      }
      const outcome = note.locked
        ? await unlockNote(client, noteId)
        : await lockNote(client, noteId);
      if (outcome.status === "ok") {
        toast.success(note.locked ? "ロックを解除しました" : "ロックしました");
      } else if (outcome.status === "skipped" && outcome.reason === "behind") {
        toast.error("同期が終わってからもう一度お試しください。");
      } else if (outcome.status === "skipped" && outcome.reason === "unsent") {
        toast.error("未送信の変更があります。同期後にもう一度お試しください。");
      } else {
        toast.error("処理できませんでした。");
      }
    } finally {
      setBusy(false);
    }
  };

  const hidden = note.locked && !unlocked;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 flex items-center gap-1 border-b px-2 py-2 backdrop-blur"
        style={{ top: "env(safe-area-inset-top, 0px)" }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onBack}
          aria-label="戻る"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Button>

        <Input
          value={hidden ? t.empty.lockedNote : draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={hidden}
          placeholder="タイトル"
          aria-label="メモのタイトル"
          className="h-9 flex-1 border-0 bg-transparent px-2 text-base font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="メモの操作">
              <MoreHorizontal className="size-5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => void setNotePinned(noteId, !note.pinned)}>
              {note.pinned ? (
                <PinOff className="size-4" aria-hidden />
              ) : (
                <Pin className="size-4" aria-hidden />
              )}
              {note.pinned ? t.action.unpin : t.action.pin}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => void toggleLock()}>
              {note.locked ? (
                <LockOpen className="size-4" aria-hidden />
              ) : (
                <Lock className="size-4" aria-hidden />
              )}
              {note.locked ? t.action.unlock : t.action.lock}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={async () => {
                await setNoteTrashed(noteId, true);
                onBack();
                toast("ゴミ箱に移動しました", {
                  action: {
                    label: "元に戻す",
                    onClick: () => void setNoteTrashed(noteId, false),
                  },
                });
              }}
            >
              <Trash2 className="size-4" aria-hidden />
              {t.action.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {hidden ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Lock className="text-muted-foreground size-8" aria-hidden />
            <p className="text-sm font-medium">{t.empty.lockedNote}</p>
            <p className="text-muted-foreground text-xs">{t.empty.lockedHint}</p>
            <Button className="mt-2" onClick={() => void requestUnlock()}>
              {t.vault.unlock}
            </Button>
          </div>
        ) : (
          <NoteEditor noteId={noteId} locked={note.locked} />
        )}
      </div>
    </div>
  );
}
