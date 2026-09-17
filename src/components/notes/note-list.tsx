"use client";

import { FilePlus2, Lock, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFolder, useNotes } from "@/lib/hooks/data";
import { useFolderName, useNoteTitle } from "@/lib/hooks/use-decrypted";
import { createNote } from "@/lib/sync/mutations";
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

function NoteRow({
  note,
  selected,
  onSelect,
}: {
  note: Note;
  selected: boolean;
  onSelect: (noteId: string) => void;
}) {
  const title = useNoteTitle(note);
  return (
    <button
      type="button"
      onClick={() => onSelect(note.noteId)}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left last:border-b-0",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="flex items-center gap-1.5">
        {note.pinned ? <Pin className="size-3 shrink-0 opacity-60" aria-hidden /> : null}
        {note.locked ? <Lock className="size-3 shrink-0 opacity-60" aria-hidden /> : null}
        <span className="truncate text-sm font-medium">{title || "無題のメモ"}</span>
      </span>
      <span className="text-muted-foreground flex items-center gap-2 text-xs">
        <span className="shrink-0">{relativeDate(note.updatedAt)}</span>
        <span className="truncate">
          {note.locked ? t.empty.lockedHint : (note.preview ?? "")}
        </span>
      </span>
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-semibold">{heading}</h2>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t.action.newNote}
          onClick={async () => onSelectNote(await createNote({ folderId }))}
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
            onClick={async () => onSelectNote(await createNote({ folderId }))}
          >
            {t.action.newNote}
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {notes.map((note) => (
            <NoteRow
              key={note.noteId}
              note={note}
              selected={note.noteId === selectedNoteId}
              onSelect={onSelectNote}
            />
          ))}
        </ScrollArea>
      )}
    </div>
  );
}
