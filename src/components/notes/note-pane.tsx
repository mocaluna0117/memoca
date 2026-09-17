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
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SyncBadge } from "@/components/shell/sync-badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useNote } from "@/lib/hooks/data";
import { useNoteTitle, useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { useVaultUi } from "@/lib/store/vault-ui";
import { renameNote, setNotePinned, setNoteTrashed } from "@/lib/sync/mutations";
import { lockNote, unlockNote } from "@/lib/vault/actions";
import { t } from "@/lib/i18n/ja";

/** Long enough to coalesce typing, short enough not to feel unsaved. */
const TITLE_DEBOUNCE_MS = 250;

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

  /**
   * The title field is a controlled draft that knows which note it belongs to
   * and whether the person has touched it.
   *
   * Both matter: switching notes while a debounce is in flight must not write
   * the old title onto the new note, and a stored title arriving a moment later
   * must not wipe what is already being typed.
   */
  const [draft, setDraft] = useState({ noteId, value: title, dirty: false });
  const [busy, setBusy] = useState(false);

  if (draft.noteId !== noteId) {
    setDraft({ noteId, value: note ? title : "", dirty: false });
  } else if (note && !draft.dirty && draft.value !== title) {
    // Adopt a title that changed elsewhere, but only while the field is idle.
    setDraft({ noteId, value: title, dirty: false });
  } else if (note && draft.dirty && draft.value === title) {
    // The edit has been saved; allow remote changes to flow in again.
    setDraft({ noteId, value: title, dirty: false });
  }

  const pendingTitle = useRef<{ noteId: string; value: string } | null>(null);

  useEffect(() => {
    if (!draft.dirty || draft.noteId !== noteId || draft.value === title) return;
    pendingTitle.current = { noteId: draft.noteId, value: draft.value };
    const handle = setTimeout(() => {
      pendingTitle.current = null;
      void renameNote(draft.noteId, draft.value);
    }, TITLE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, title, noteId]);

  // A debounce that is still counting when the pane goes away would lose the
  // edit. Anything pending is written on the way out.
  useEffect(
    () => () => {
      const pending = pendingTitle.current;
      pendingTitle.current = null;
      if (pending) void renameNote(pending.noteId, pending.value);
    },
    [],
  );

  if (note === undefined) {
    return (
      <div className="space-y-3 px-4 py-6 sm:px-10">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }
  if (note === null) {
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
          value={hidden ? t.empty.lockedNote : draft.value}
          onChange={(event) =>
            setDraft({ noteId, value: event.target.value, dirty: true })
          }
          disabled={hidden}
          placeholder="タイトル"
          aria-label="メモのタイトル"
          className="h-9 flex-1 border-0 bg-transparent px-2 text-base font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
        />

        <SyncBadge className="mr-1" />

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
