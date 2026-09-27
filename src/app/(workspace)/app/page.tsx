"use client";

import { Suspense, useEffect, useLayoutEffect, useRef } from "react";
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
  usePhoneScroll(selection.noteId);

  return (
    <div className="flex flex-1 md:min-h-0">
      {/* Middle pane: hidden on phones while a note is open. */}
      <section
        className={cn(
          "min-w-0 flex-col border-r md:flex md:min-h-0 md:w-80 md:shrink-0",
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
        className={cn(
          "min-w-0 flex-1 flex-col md:min-h-0",
          selection.noteId ? "flex" : "hidden md:flex",
        )}
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

const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

/**
 * On a phone the list and the note take turns on one page that scrolls as a
 * whole. A note opens at its top, not wherever the list had been scrolled
 * to, and going back finds the list where it was left.
 */
function usePhoneScroll(noteId: string | null) {
  const listY = useRef(0);
  const shown = useRef(noteId);

  useEffect(() => {
    if (noteId !== null) return;
    const remember = () => {
      // Opening a note scrolls the page to its top; that is not the list's.
      if (shown.current === null) listY.current = window.scrollY;
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, [noteId]);

  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = noteId;
    if (before === noteId || !isPhone()) return;
    window.scrollTo(0, noteId === null ? listY.current : 0);
  }, [noteId]);
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
