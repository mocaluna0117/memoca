"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dayLabel, dayOf, journalDay, neighbourDays, openDay } from "@/lib/journal";
import { useWorkspace } from "@/lib/hooks/workspace";
import { JOURNAL_FOLDER_ID } from "@/lib/sync/mutations";

/**
 * Over a day's note: the days before and after it that have a note, to go
 * to, and today's, made if need be. Nothing over any other note.
 */
export function JournalNav({ noteId }: { noteId: string }) {
  const { navigate } = useWorkspace();
  const day = journalDay(noteId);
  const near = useLiveQuery(() => (day ? neighbourDays(day) : null), [day]);
  if (!day) return null;
  const today = dayOf(new Date());
  // By its day: the day's note may have an id of its own (see openDay), and
  // today's is made if there is none.
  const open = (to: string) =>
    void openDay(to).then((id) =>
      navigate({ folderId: JOURNAL_FOLDER_ID, pinned: false, noteId: id }),
    );

  return (
    <nav
      aria-label="日付のメモ"
      className="flex items-center justify-between gap-2 border-b px-2 py-1 text-sm sm:px-6"
    >
      <Button
        variant="ghost"
        size="sm"
        className="gap-1"
        disabled={!near?.before}
        onClick={() => near?.before && open(near.before)}
      >
        <ChevronLeft className="size-4" aria-hidden />
        {near?.before ? dayLabel(near.before) : "前の日"}
      </Button>
      {day !== today ? (
        <Button variant="ghost" size="sm" className="gap-1" onClick={() => open(today)}>
          <CalendarDays className="size-4" aria-hidden />
          今日
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="gap-1"
        disabled={!near?.after}
        onClick={() => near?.after && open(near.after)}
      >
        {near?.after ? dayLabel(near.after) : "次の日"}
        <ChevronRight className="size-4" aria-hidden />
      </Button>
    </nav>
  );
}
