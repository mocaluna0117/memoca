"use client";

import { FilePlus2, Lock, Pin } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { InlineRename } from "@/components/shell/inline-rename";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFolder, useNotes } from "@/lib/hooks/data";
import { useFolderName, useNoteTitle, useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { renameNote } from "@/lib/sync/mutations";
import { useLockActions } from "@/components/vault/use-lock-actions";
import type { Note } from "@/lib/types";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

function relativeDate(at: number): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return "たった今";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分前`;
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

const ROW_CLASS = "flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left last:border-b-0";

function NoteRow({
  note,
  selected,
  editing,
  hintId,
  onSelect,
  onStartRename,
  onEndRename,
  onArrow,
}: {
  note: Note;
  selected: boolean;
  editing: boolean;
  hintId: string;
  onSelect: (noteId: string) => void;
  onStartRename: (noteId: string) => void;
  onEndRename: (noteId: string, byKeyboard: boolean) => void;
  /** Moves focus to another row; true when the key was one it handles. */
  onArrow: (noteId: string, key: string) => boolean;
}) {
  const title = useNoteTitle(note);
  const unlocked = useVaultUnlocked();
  // A locked note's title is unreadable until the vault is open, and there is
  // nothing to edit in a placeholder.
  const renamable = !note.locked || unlocked;

  const icons = (
    <>
      {note.pinned ? <Pin className="size-3 shrink-0 opacity-60" aria-hidden /> : null}
      {note.locked ? <Lock className="size-3 shrink-0 opacity-60" aria-hidden /> : null}
    </>
  );
  const details = (
    <span className="text-muted-foreground flex items-center gap-2 text-xs">
      <span className="shrink-0">{relativeDate(note.updatedAt)}</span>
      <span className="truncate">
        {note.locked ? (unlocked ? "ロック中" : t.empty.lockedHint) : (note.preview ?? "")}
      </span>
    </span>
  );

  if (editing) {
    // Not inside the button: a field in a button would have its Space and
    // Enter taken by the button.
    return (
      <div className={cn(ROW_CLASS, selected && "bg-accent")}>
        <span className="flex items-center gap-1.5">
          {icons}
          <InlineRename
            initialValue={title}
            label="メモ名"
            placeholder="無題のメモ"
            className="-my-0.5 h-6 font-medium"
            onSubmit={(value) => renameNote(note.noteId, value)}
            onDone={(byKeyboard) => onEndRename(note.noteId, byKeyboard)}
          />
        </span>
        {details}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-note-row={note.noteId}
      aria-describedby={hintId}
      onClick={(event) => {
        // Safari does not focus a button it clicks, and Enter acts on the
        // focused row, so a click has to put focus there itself.
        event.currentTarget.focus();
        onSelect(note.noteId);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          if (!renamable) return;
          // Stops the button's own Enter, which would open the note instead.
          event.preventDefault();
          onStartRename(note.noteId);
        } else if (!event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
          if (onArrow(note.noteId, event.key)) event.preventDefault();
        }
      }}
      className={cn(
        ROW_CLASS,
        // Inset, so the scroll area's edge does not clip the ring.
        "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-inset",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="flex items-center gap-1.5">
        {icons}
        <span className="truncate text-sm font-medium">{title || "無題のメモ"}</span>
      </span>
      {details}
    </button>
  );
}


export function NoteList({
  folderId,
  selectedNoteId,
  onSelectNote,
}: {
  folderId: string | null;
  selectedNoteId: string | null;
  onSelectNote: (noteId: string) => void;
}) {
  const folder = useFolder(folderId);
  const folderName = useFolderName(folder);
  const notes = useNotes(folderId ? { kind: "folder", folderId } : { kind: "all" });

  const heading = folderId ? folderName || "フォルダ" : t.nav.allNotes;
  const { createNoteIn } = useLockActions();

  // The note being renamed in place, as a file explorer does on Enter.
  const [editing, setEditing] = useState<string | null>(null);
  const hintId = useId();
  // Enter and Escape hand focus back to the row, once it is a button again.
  const list = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const noteId = refocus.current;
    if (!noteId || editing !== null) return;
    refocus.current = null;
    list.current?.querySelector<HTMLElement>(`[data-note-row="${noteId}"]`)?.focus();
  }, [editing]);

  // Up and down walk the list as they do in a file explorer. Focus only:
  // Space is what opens a note.
  const onArrow = (noteId: string, key: string): boolean => {
    const index = notes.findIndex((note) => note.noteId === noteId);
    const targets: Record<string, Note | undefined> = {
      ArrowUp: notes[index - 1],
      ArrowDown: notes[index + 1],
      Home: notes[0],
      End: notes.at(-1),
    };
    if (!(key in targets)) return false;
    const target = targets[key];
    if (target) {
      list.current
        ?.querySelector<HTMLElement>(`[data-note-row="${target.noteId}"]`)
        ?.focus();
    }
    return true;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-semibold">{heading}</h2>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t.action.newNote}
          onClick={async () => {
            const id = await createNoteIn(folderId);
            if (id) onSelectNote(id);
          }}
        >
          <FilePlus2 className="size-4" aria-hidden />
        </Button>
      </div>

      {notes.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm">{t.empty.noNotes}</p>
          <p className="text-xs">{t.empty.noNotesHint}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={async () => {
            const id = await createNoteIn(folderId);
            if (id) onSelectNote(id);
          }}
          >
            {t.action.newNote}
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <p id={hintId} className="sr-only">
            上下の矢印キーで移動、Enter でタイトルを変更、スペースで開きます。
          </p>
          <div ref={list}>
            {notes.map((note) => (
              <NoteRow
                key={note.noteId}
                note={note}
                selected={note.noteId === selectedNoteId}
                editing={note.noteId === editing}
                hintId={hintId}
                onSelect={onSelectNote}
                onStartRename={setEditing}
                onEndRename={(noteId, byKeyboard) => {
                  if (byKeyboard) refocus.current = noteId;
                  setEditing(null);
                }}
                onArrow={onArrow}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
