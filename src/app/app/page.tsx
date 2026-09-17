"use client";

import { Suspense } from "react";
import { MobileHeader } from "@/components/shell/app-shell";
import { NoteList } from "@/components/notes/note-list";
import { NotePane } from "@/components/notes/note-pane";
import { Skeleton } from "@/components/ui/skeleton";
import { useFolder } from "@/lib/hooks/data";
import { useFolderName } from "@/lib/hooks/use-decrypted";
import { useWorkspace } from "@/lib/hooks/workspace";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

function Workspace() {
  const { selection, openNote, closeNote } = useWorkspace();
  const folder = useFolder(selection.folderId);
  const folderName = useFolderName(folder);
  const heading = selection.folderId ? folderName || "フォルダ" : t.nav.allNotes;

  return (
    <div className="flex min-h-dvh flex-1">
      {/* Middle pane: hidden on phones while a note is open. */}
      <section
        className={cn(
          "min-w-0 flex-col border-r md:flex md:w-80 md:shrink-0",
          selection.noteId ? "hidden" : "flex flex-1",
        )}
      >
        <MobileHeader title={heading} />
        <div className="min-h-0 flex-1">
          <NoteList
            folderId={selection.folderId}
            selectedNoteId={selection.noteId}
            onSelectNote={openNote}
          />
        </div>
      </section>

      <section
        className={cn("min-w-0 flex-1 flex-col", selection.noteId ? "flex" : "hidden md:flex")}
      >
        {selection.noteId ? (
          <NotePane noteId={selection.noteId} onBack={closeNote} />
        ) : (
          <div className="text-muted-foreground hidden flex-1 items-center justify-center text-sm md:flex">
            メモを選ぶと、ここに表示されます
          </div>
        )}
      </section>
    </div>
  );
}

export default function AppPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 flex-col gap-3 p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full" />
        </div>
      }
    >
      <Workspace />
    </Suspense>
  );
}
