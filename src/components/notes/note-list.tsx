"use client";

import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpDown, FilePlus2, Lock, Pin } from "lucide-react";
import { type CSSProperties, useEffect, useId, useMemo, useRef, useState } from "react";
import { InlineRename } from "@/components/shell/inline-rename";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFolder, useNotes } from "@/lib/hooks/data";
import {
  LOCKED_LABEL,
  useFolderName,
  useLockedTitles,
  useNoteTitle,
  useVaultUnlocked,
} from "@/lib/hooks/use-decrypted";
import { useNoteOrder } from "@/lib/hooks/use-note-order";
import { HOLD_MS } from "@/lib/gesture/drawer-swipe";
import {
  NOTE_ORDERS,
  type NoteOrder,
  createdAt,
  isNoteOrder,
  orderNotes,
  placeAt,
} from "@/lib/note-order";
import { db } from "@/lib/db";
import { moveNote, renameNote } from "@/lib/sync/mutations";
import { useLockActions } from "@/components/vault/use-lock-actions";
import { STAND_IN_CLASS, noteName } from "@/lib/note-name";
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

/** What a row is given to be dragged by, where notes are placed by hand. */
type RowDrag = {
  ref: (element: HTMLElement | null) => void;
  style: CSSProperties;
  listeners: Record<string, unknown> | undefined;
  dragging: boolean;
};

/** A row that can be dragged to another place in the list. */
function SortableNoteRow(props: Omit<Parameters<typeof NoteRow>[0], "drag">) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: props.note.noteId,
    disabled: props.editing,
  });
  return (
    <NoteRow
      {...props}
      drag={{
        ref: setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        listeners,
        dragging: isDragging,
      }}
    />
  );
}

/** The list's order, chosen from a menu: by hand only for a folder's list. */
function OrderMenu({
  order,
  manualAllowed,
  onChange,
}: {
  order: NoteOrder;
  manualAllowed: boolean;
  onChange: (order: NoteOrder) => void;
}) {
  const label = NOTE_ORDERS.find((each) => each.value === order)?.label ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`並び順（${label}）`}>
          <ArrowUpDown className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>並び順</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={order}
          onValueChange={(value) => {
            if (isNoteOrder(value)) onChange(value);
          }}
        >
          {NOTE_ORDERS.filter((each) => manualAllowed || each.value !== "manual").map((each) => (
            <DropdownMenuRadioItem key={each.value} value={each.value}>
              {each.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NoteRow({
  note,
  selected,
  editing,
  hintId,
  onSelect,
  onStartRename,
  onEndRename,
  onArrow,
  onNudge,
  drag,
  shownAt,
}: {
  note: Note;
  /** The time the row shows: when the note was changed, or made when ordered by that. */
  shownAt: number;
  selected: boolean;
  editing: boolean;
  hintId: string;
  onSelect: (noteId: string) => void;
  onStartRename: (noteId: string) => void;
  onEndRename: (noteId: string, byKeyboard: boolean) => void;
  /** Moves focus to another row; true when the key was one it handles. */
  onArrow: (noteId: string, key: string) => boolean;
  /** Moves the note one place up or down, where notes are placed by hand. */
  onNudge?: (noteId: string, direction: -1 | 1) => void;
  /** What makes the row draggable, where notes are placed by hand. */
  drag?: RowDrag;
}) {
  const title = useNoteTitle(note);
  const unlocked = useVaultUnlocked();
  // With no title, its first line stands in for one, and is not said again below.
  const name = noteName(title, note.locked ? null : note.preview);
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
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{relativeDate(shownAt)}</span>
      <span className="truncate">
        {note.locked
          ? unlocked
            ? "ロック中"
            : t.empty.lockedHint
          : name.standIn
            ? ""
            : (note.preview ?? "")}
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
            placeholder={name.text}
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
      ref={drag?.ref}
      style={drag?.style}
      {...drag?.listeners}
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
        } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          onNudge?.(note.noteId, event.key === "ArrowUp" ? -1 : 1);
        } else if (!event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
          if (onArrow(note.noteId, event.key)) event.preventDefault();
        }
      }}
      className={cn(
        ROW_CLASS,
        // Inset, so the scroll area's edge does not clip the ring.
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "bg-accent" : "hover:bg-accent/50",
        // Held down to drag on a phone: not a text selection, nor its menu.
        drag && "touch-manipulation select-none [-webkit-touch-callout:none]",
        drag?.dragging && "relative z-10 bg-background shadow-md",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {icons}
        <span
          className={cn("min-w-0 truncate text-sm", name.standIn ? STAND_IN_CLASS : "font-medium")}
        >
          {name.text}
        </span>
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
  const listed = useNotes(folderId ? { kind: "folder", folderId } : { kind: "all" });
  const [order, setOrder] = useNoteOrder(folderId);
  const manual = order === "manual";
  // By name, as each row shows it: a locked note's title decrypted, with the
  // vault open, and a note with no title by its first line.
  const lockedTitles = useLockedTitles(listed, order === "title");
  const notes = useMemo(() => {
    if (order !== "title") return orderNotes(listed, order);
    const names = new Map(
      listed.map((note) => [
        note.noteId,
        note.locked
          ? noteName(lockedTitles.get(note.noteId) ?? LOCKED_LABEL, null).text
          : noteName(note.title, note.preview).text,
      ]),
    );
    return orderNotes(listed, order, names);
  }, [listed, order, lockedTitles]);

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

  // A row moved by its keys keeps focus: the list is drawn again in its new
  // order, which the browser takes as the focused row going away.
  const moved = useRef<string | null>(null);
  useEffect(() => {
    const noteId = moved.current;
    if (!noteId) return;
    moved.current = null;
    list.current?.querySelector<HTMLElement>(`[data-note-row="${noteId}"]`)?.focus();
  }, [notes]);

  const placing = useRef<Promise<void>>(Promise.resolve());

  /**
   * Puts a note at `index` among the others of its kind (pinned, or not:
   * pinned notes stay above), by the sort key between its new neighbours'.
   */
  const place = (note: Note, index: number) => {
    const others = notes.filter(
      (each) => each.pinned === note.pinned && each.noteId !== note.noteId,
    );
    if (index < 0 || index > others.length) return;
    const { key, rekeyed } = placeAt(others, index);
    // One move at a time, each from the list as the one before left it.
    placing.current = placing.current
      .then(async () => {
        for (const each of [...rekeyed, { noteId: note.noteId, sortKey: key }]) {
          // Moved to another folder since (on another device, say): left
          // there, not taken back to this one.
          const now = await db().notes.get(each.noteId);
          if (now?.folderId !== note.folderId) continue;
          await moveNote(each.noteId, note.folderId, each.sortKey);
        }
      })
      .catch(() => {});
  };

  // What a screen reader is told of a move made with the keys.
  const [spoken, setSpoken] = useState("");
  /** A note's name as its row shows it, as far as the list knows it. */
  const nameOf = (noteId: string | number) => {
    const note = notes.find((each) => each.noteId === noteId);
    if (!note) return "メモ";
    return note.locked
      ? (lockedTitles.get(note.noteId) ?? LOCKED_LABEL)
      : noteName(note.title, note.preview).text;
  };

  /** Option (Alt) and up or down: one place up or down. */
  const nudge = (noteId: string, direction: -1 | 1) => {
    const note = notes.find((each) => each.noteId === noteId);
    if (!note || !manual) return;
    const group = notes.filter((each) => each.pinned === note.pinned);
    const at = group.findIndex((each) => each.noteId === noteId);
    const index = at + direction;
    if (index < 0 || index >= group.length) {
      setSpoken("これ以上は移動できません。");
      return;
    }
    moved.current = noteId;
    place(note, index);
    const pinned = notes.filter((each) => each.pinned).length;
    const position = (note.pinned ? 0 : pinned) + index + 1;
    setSpoken(`${nameOf(noteId)}を ${notes.length} 件中 ${position} 番目に移動しました。`);
  };

  // A finger held down first, so that one moving the list scrolls it, and
  // held past the time a swipe opens the folder drawer (drawer-swipe.ts),
  // so that the two never both start; a mouse moved a little way.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: HOLD_MS + 50, tolerance: 8 } }),
  );

  /** Where a drop puts the dragged note, or null for a drop that moves nothing. */
  const dropOf = (activeId: string | number, overId: string | number | undefined) => {
    if (overId === undefined || activeId === overId) return null;
    const from = notes.findIndex((each) => each.noteId === activeId);
    const to = notes.findIndex((each) => each.noteId === overId);
    const note = notes[from];
    const target = notes[to];
    // Pinned notes stay above the others: a drag across that line is not a move.
    if (!note || !target || note.pinned !== target.pinned) return null;
    const others = notes.filter(
      (each) => each.pinned === note.pinned && each.noteId !== note.noteId,
    );
    const at = others.findIndex((each) => each.noteId === target.noteId);
    return { note, index: from < to ? at + 1 : at };
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const drop = dropOf(active.id, over?.id);
    if (drop) place(drop.note, drop.index);
  };

  // Only among notes of its own kind, pinned or not, so that the others do
  // not make room for a drop that would not move it; the nearest of them,
  // so that one let go of past the list (over the phone's tab bar, say)
  // goes to the end it was taken to.
  const collisionDetection: CollisionDetection = (args) => {
    const pinned = notes.find((each) => each.noteId === args.active.id)?.pinned;
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => notes.find((each) => each.noteId === container.id)?.pinned === pinned,
      ),
    });
  };

  // dnd-kit announces drag progress to screen readers in English by default.
  const announcements = {
    onDragStart: ({ active }: { active: { id: string | number } }) =>
      `${nameOf(active.id)}をつかみました。`,
    onDragOver: ({ over }: { over: { id: string | number } | null }) =>
      over ? `${nameOf(over.id)}の位置です。` : undefined,
    onDragEnd: ({
      active,
      over,
    }: {
      active: { id: string | number };
      over: { id: string | number } | null;
    }) => (dropOf(active.id, over?.id) ? "移動しました。" : "移動をやめました。"),
    onDragCancel: () => "移動をやめました。",
  };

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
      list.current?.querySelector<HTMLElement>(`[data-note-row="${target.noteId}"]`)?.focus();
    }
    return true;
  };

  const rowProps = (note: Note) => ({
    note,
    selected: note.noteId === selectedNoteId,
    editing: note.noteId === editing,
    hintId,
    onSelect: onSelectNote,
    onStartRename: setEditing,
    onEndRename: (noteId: string, byKeyboard: boolean) => {
      if (byKeyboard) refocus.current = noteId;
      setEditing(null);
    },
    onArrow,
    onNudge: manual ? nudge : undefined,
    shownAt: order === "created" ? (createdAt(note.noteId) ?? note.updatedAt) : note.updatedAt,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-semibold">{heading}</h2>
        <div className="flex shrink-0 items-center">
          <OrderMenu order={order} manualAllowed={folderId !== null} onChange={setOrder} />
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
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
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
        <ScrollArea
          data-scroll="list"
          // Radix lays the rows out in a table, as wide as the widest: made a
          // block, a long name is cut short with … rather than widening the list.
          className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
        >
          <p id={hintId} className="sr-only">
            上下の矢印キーで移動、Enter でタイトルを変更、スペースで開きます。
            {manual ? "Option（Alt）と上下の矢印キーで並べ替えます。" : ""}
          </p>
          <p className="sr-only" aria-live="polite">
            {spoken}
          </p>
          <div ref={list}>
            {manual ? (
              <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                modifiers={[restrictToVerticalAxis]}
                accessibility={{ announcements }}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={notes.map((note) => note.noteId)}
                  strategy={verticalListSortingStrategy}
                >
                  {notes.map((note) => (
                    <SortableNoteRow key={note.noteId} {...rowProps(note)} />
                  ))}
                </SortableContext>
              </DndContext>
            ) : (
              notes.map((note) => <NoteRow key={note.noteId} {...rowProps(note)} />)
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
