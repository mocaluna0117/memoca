"use client";

import {
  type Active,
  type DragEndEvent,
  closestCenter,
  pointerWithin,
  useDraggable,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUpDown,
  CheckCircle2,
  Circle,
  FileInput,
  FilePlus2,
  LayoutTemplate,
  ListChecks,
  Lock,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { FolderPicker } from "@/components/folders/folder-picker";
import { InlineRename } from "@/components/shell/inline-rename";
import { dragData, shownUnderPointer, useWorkspaceDrag } from "@/components/shell/workspace-dnd";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { useFolder, useNotes } from "@/lib/hooks/data";
import {
  LOCKED_LABEL,
  useFolderName,
  useLockedTitles,
  useNoteTitle,
  useVaultUnlocked,
} from "@/lib/hooks/use-decrypted";
import { useNoteOrder } from "@/lib/hooks/use-note-order";
import { TruncatedName } from "@/components/shell/truncated-name";
import { useClientValue, useMediaQuery } from "@/lib/hooks/use-client-value";
import { isApple } from "@/lib/platform";
import { useMenuDialog } from "@/lib/hooks/use-menu-dialog";
import { extendTo, takenWith, toggled } from "@/lib/note-selection";
import {
  NOTE_ORDERS,
  type NoteOrder,
  createdAt,
  isNoteOrder,
  orderNotes,
  placeAt,
} from "@/lib/note-order";
import { db } from "@/lib/db";
import {
  moveNote,
  placePinned,
  renameNote,
  setNotePinned,
  setNotesPinned,
} from "@/lib/sync/mutations";
import { useLockActions } from "@/components/vault/use-lock-actions";
import { STAND_IN_CLASS, noteName } from "@/lib/note-name";
import type { Note } from "@/lib/types";
import { t } from "@/lib/i18n/ja";
import { TemplatePicker } from "@/components/notes/template-picker";
import { TEMPLATES_FOLDER_ID, TemplateUnavailableError, fillFromTemplate } from "@/lib/templates";
import { useWorkspace } from "@/lib/hooks/workspace";
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

/** What a row is given to be dragged by: to a folder, or, placed by hand, to another place in the list. */
type RowDrag = {
  ref: (element: HTMLElement | null) => void;
  style?: CSSProperties;
  listeners: Record<string, unknown> | undefined;
  dragging: boolean;
};

/** What a row's drag carries: the list it is in (`owner`) and the note. */
const noteData = (owner: string, noteId: string) => ({ owner, kind: "note" as const, noteId });

/** A row that can be dragged to another place in the list, or to a folder. */
function SortableNoteRow({
  owner,
  ...props
}: Omit<Parameters<typeof NoteRow>[0], "drag"> & { owner: string }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: props.note.noteId,
    data: noteData(owner, props.note.noteId),
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

/** A row that can be dragged to a folder, staying where it is in the list. */
function DraggableNoteRow({
  owner,
  ...props
}: Omit<Parameters<typeof NoteRow>[0], "drag"> & { owner: string }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: props.note.noteId,
    data: noteData(owner, props.note.noteId),
    disabled: props.editing,
  });
  return <NoteRow {...props} drag={{ ref: setNodeRef, listeners, dragging: isDragging }} />;
}

/**
 * The notes chosen in a folder's list (`folderId`): whether it is set to
 * choose them with a click each (`on`), where a Shift and a click goes from
 * (`anchor`), and what was chosen when that was set (`base`).
 */
type Choice = {
  folderId: string | null;
  ids: ReadonlySet<string>;
  on: boolean;
  anchor: string | null;
  base: ReadonlySet<string>;
};

/** None chosen, the list not set to choose. */
const unchosen = (folderId: string | null): Choice => ({
  folderId,
  ids: new Set(),
  on: false,
  anchor: null,
  base: new Set(),
});

/** Opens a row's menu, as a right click or a long press would, at its middle. */
function openMenuOn(row: HTMLElement) {
  const box = row.getBoundingClientRect();
  row.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
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
  choosing,
  chosen,
  hintId,
  onSelect,
  onStartRename,
  onEndRename,
  onArrow,
  onNudge,
  drag,
  menu,
  shownAt,
}: {
  note: Note;
  /** The time the row shows: when the note was changed, or made when ordered by that. */
  shownAt: number;
  selected: boolean;
  editing: boolean;
  /** The list is set to choose notes: a click chooses this one, or not. */
  choosing: boolean;
  /** Chosen, to be moved along with the others chosen. */
  chosen: boolean;
  hintId: string;
  /** A click on the row, with the keys held (⌘/Ctrl to choose it, Shift to choose up to it). */
  onSelect: (noteId: string, held: { meta: boolean; ctrl: boolean; shift: boolean }) => void;
  onStartRename: (noteId: string) => void;
  onEndRename: (noteId: string, byKeyboard: boolean) => void;
  /** Moves focus to another row; true when the key was one it handles. */
  onArrow: (noteId: string, key: string) => boolean;
  /** Moves the note one place up or down, where notes are placed by hand. */
  onNudge?: (noteId: string, direction: -1 | 1) => void;
  /** What makes the row draggable: to a folder, and, placed by hand, in the list. */
  drag?: RowDrag;
  /** What its menu (a right click, a long press) offers. */
  menu: ReactNode;
}) {
  const title = useNoteTitle(note);
  const unlocked = useVaultUnlocked();
  // With no title, its first line stands in for one, and is not said again below.
  const name = noteName(title, note.locked ? null : note.preview);
  // A locked note's title is unreadable until the vault is open, and there is
  // nothing to edit in a placeholder.
  const renamable = !note.locked || unlocked;
  // A finger on a row dragged by one: the browser's own long press (Android
  // sends one, sooner than the drag starts) is not to open the menu too.
  const touching = useRef(false);

  const icons = (
    <>
      {choosing ? (
        chosen ? (
          <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <Circle className="size-4 shrink-0 opacity-40" aria-hidden />
        )
      ) : null}
      {note.pinned ? <Pin className="size-3.5 shrink-0 fill-current text-amber-500" aria-hidden /> : null}
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
    // Modal: the finger let go after a long press does not click the row
    // under it, opening the note under the menu.
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          ref={drag?.ref}
          style={drag?.style}
          {...drag?.listeners}
          data-note-row={note.noteId}
          // A toggle while the list chooses notes.
          aria-pressed={choosing ? chosen : undefined}
          aria-describedby={hintId}
          onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
            // A finger held on a row that is dragged by one is a drag (its menu
            // comes from letting go without moving it, see onDragEnd), not the
            // menu's own long press as well.
            touching.current = Boolean(drag) && event.pointerType === "touch";
            if (touching.current) event.preventDefault();
          }}
          onPointerUp={() => {
            touching.current = false;
          }}
          onPointerCancel={() => {
            touching.current = false;
          }}
          onContextMenu={(event) => {
            // The browser's own, from the finger still down: the drag's. The
            // one opened on letting go is the page's own (not trusted).
            if (touching.current && event.nativeEvent.isTrusted) event.preventDefault();
          }}
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            // Safari does not focus a button it clicks, and Enter acts on the
            // focused row, so a click has to put focus there itself.
            event.currentTarget.focus();
            onSelect(note.noteId, {
              meta: event.metaKey,
              ctrl: event.ctrlKey,
              shift: event.shiftKey,
            });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
              // Its menu, from the keys: a Mac has no menu key, and Windows
              // would open it again on its own.
              event.preventDefault();
              openMenuOn(event.currentTarget);
            } else if (event.key === "Enter") {
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
            // While choosing, the chosen ones; otherwise, the one open.
            (choosing ? chosen : selected) ? "bg-accent" : "hover:bg-accent/50",
            // The one whose menu is open.
            "data-[state=open]:bg-accent/50",
            // Held down for its menu or to drag it: not a text selection, nor
            // the browser's own menu.
            "touch-manipulation select-none [-webkit-touch-callout:none]",
            // Where it was taken from, while it is dragged.
            drag?.dragging && "opacity-40",
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {icons}
            <TruncatedName
              text={name.text}
              className={cn("min-w-0 text-sm", name.standIn ? STAND_IN_CLASS : "font-medium")}
            />
          </span>
          {details}
        </button>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}

export function NoteList({
  folderId,
  pinnedOnly = false,
  selectedNoteId,
  onSelectNote,
}: {
  folderId: string | null;
  /** With no folder: the pinned notes, of every folder, rather than all. */
  pinnedOnly?: boolean;
  selectedNoteId: string | null;
  onSelectNote: (noteId: string) => void;
}) {
  const folder = useFolder(folderId);
  const folderName = useFolderName(folder);
  const listed = useNotes(
    folderId ? { kind: "folder", folderId } : pinnedOnly ? { kind: "pinned" } : { kind: "all" },
  );
  /** Which list this is: a folder's, the pinned notes, or all. */
  const listKey = folderId ?? (pinnedOnly ? "@pinned" : null);
  const [chosenOrder, setOrder] = useNoteOrder(folderId);
  // The pinned, in their own order, show when each was last changed, as
  // they did: not whatever all notes are set to show.
  const order: NoteOrder = pinnedOnly ? "updated" : chosenOrder;
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

  const heading = folderId ? folderName || "フォルダ" : pinnedOnly ? t.nav.pinned : t.nav.allNotes;
  const { createNoteIn, moveNoteTo, moveNotesTo } = useLockActions();
  /** A new note here: in this folder, or Inbox, and pinned among the pinned. */
  const newNote = async () => {
    const id = await createNoteIn(folderId);
    if (id && pinnedOnly) await setNotePinned(id, true);
    return id;
  };
  const { openFolder } = useWorkspace();
  const [picking, setPicking] = useState(false);
  /** A new note here, as newNote makes one, with a template's title and body. */
  const fromTemplate = async (templateId: string) => {
    const id = await newNote();
    if (!id) return;
    onSelectNote(id);
    try {
      await fillFromTemplate(id, templateId);
    } catch (error) {
      toast.error(error instanceof TemplateUnavailableError ? t.templates.unavailable : "テンプレートを使えませんでした。");
    }
  };

  // Notes chosen to be moved together: with ⌘/Ctrl (⌘ alone on a Mac,
  // where Ctrl and a click is a right click) or Shift and a click, or a tap
  // each once the list is set to choose. For this list only: another folder
  // opened, none are, coming back included; one gone from it (moved, say),
  // not either. With where a Shift and a click chooses from (`anchor`), and
  // what was chosen when it was set (`base`), as in Finder.
  const [choice, setChoice] = useState<Choice>(() => unchosen(listKey));
  if (choice.folderId !== listKey) setChoice(unchosen(listKey));
  const chosen = useMemo(
    () => new Set([...choice.ids].filter((id) => notes.some((note) => note.noteId === id))),
    [choice.ids, notes],
  );
  const choosing = choice.on || chosen.size > 0;
  const stopChoosing = () => setChoice(unchosen(listKey));
  const apple = useClientValue(() => isApple(navigator.userAgent), false);
  const ids = notes.map((note) => note.noteId);
  /** Chooses one more, or one less: where a Shift and a click goes from next. */
  const toggleChosen = (noteId: string, on = choice.on) => {
    const next = toggled(chosen, noteId);
    setChoice({ folderId: listKey, ids: next, on, anchor: noteId, base: next });
  };

  /** A click on a row: chooses it, or up to it, or opens it. */
  const onRowSelect = (noteId: string, held: { meta: boolean; ctrl: boolean; shift: boolean }) => {
    if (held.shift) {
      const anchor = choice.anchor ?? selectedNoteId ?? noteId;
      setChoice({ ...choice, ids: extendTo(choice.base, ids, anchor, noteId), anchor });
      return;
    }
    // ⌘ anywhere; Ctrl but on a Mac, where it and a click is a right click.
    if (held.meta || (!apple && held.ctrl) || choosing) {
      toggleChosen(noteId);
      return;
    }
    // Opened: where a Shift and a click chooses from.
    setChoice({ ...unchosen(listKey), anchor: noteId });
    onSelectNote(noteId);
  };

  // Where the notes chosen (or one) are to be moved, picked in a dialog. One
  // move at a time: locking them can take a while.
  const [moving, setMoving] = useState<Note[] | null>(null);
  /** The row the dialog was opened for, to go back to. */
  const pickedFor = useRef<string | null>(null);
  const pickFolderFor = (picked: Note[]) => {
    pickedFor.current = picked[0]?.noteId ?? null;
    setMoving(picked);
  };
  const [busy, setBusy] = useState(false);
  const { openDialog, onCloseAutoFocus } = useMenuDialog();
  /** Where focus goes once rows have gone: the row that took the first one's place. */
  const refocusAt = useRef<number | null>(null);
  /**
   * Moves notes to a folder, those already there staying as they are. Those
   * that went are no longer chosen; all of them gone, the list stops
   * choosing.
   */
  const moveTo = async (moved: Note[], to: string | null) => {
    const going = moved.filter((note) => note.folderId !== to);
    if (going.length === 0) {
      toast(
        moved.length > 1
          ? "選んだメモは、すでにそのフォルダにあります"
          : "すでにそのフォルダにあります",
      );
      return;
    }
    if (busy) return;
    setBusy(true);
    const first = ids.indexOf(going[0]!.noteId);
    const returnFocus = list.current?.querySelector<HTMLElement>(
      `[data-note-row="${going[0]!.noteId}"]`,
    );
    // Before the move, which redraws the list as soon as it is written.
    refocusAt.current = first;
    try {
      const done =
        going.length === 1
          ? await moveNoteTo(going[0]!, to, returnFocus)
          : await moveNotesTo(going, to, returnFocus);
      if (!done) {
        refocusAt.current = null;
        return;
      }
      const left = new Set([...chosen].filter((id) => !going.some((note) => note.noteId === id)));
      if (left.size === 0) stopChoosing();
      else setChoice({ ...choice, ids: left, base: left });
    } finally {
      setBusy(false);
    }
  };
  /**
   * Pins notes, or unpins them, from the menu of `from`'s row. In the pinned
   * view, those unpinned leave it: no longer chosen, focus to the row now
   * where the first was. Elsewhere `from`'s row, drawn again pinned or not,
   * keeps focus.
   */
  const pinAll = async (pinned: Note[], pin: boolean, from: string) => {
    const going = pinnedOnly && !pin;
    if (going) refocusAt.current = ids.indexOf(pinned[0]!.noteId);
    else repinned.current = { noteId: from, pinned: pin };
    await setNotesPinned(
      pinned.map((note) => note.noteId),
      pin,
    );
    if (!going) return;
    const left = new Set([...chosen].filter((id) => !pinned.some((note) => note.noteId === id)));
    if (left.size === 0) stopChoosing();
    else setChoice({ ...choice, ids: left, base: left });
  };
  /** The notes a menu or a drag acts on: the chosen ones, if it is one of them. */
  const withChosen = (noteId: string) =>
    takenWith(ids, chosen, noteId).flatMap((id) => notes.filter((note) => note.noteId === id));

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

  // A row pinned or unpinned keeps focus: it is drawn again as another kind
  // of row (one placed by hand among the pinned, or not), a button anew.
  // Once it shows as it now is, the others pinned with it written one by one.
  const repinned = useRef<{ noteId: string; pinned: boolean } | null>(null);
  useEffect(() => {
    const want = repinned.current;
    if (!want || notes.find((note) => note.noteId === want.noteId)?.pinned !== want.pinned) return;
    repinned.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    list.current?.querySelector<HTMLElement>(`[data-note-row="${want.noteId}"]`)?.focus();
  }, [notes]);

  // Set to choose, or not, by a button that then goes: focus to the first
  // row, to choose with Space, or back to the list's own button.
  const focusNext = useRef<"rows" | "header" | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "rows") list.current?.querySelector<HTMLElement>("[data-note-row]")?.focus();
    else if (next === "header") header.current?.querySelector<HTMLElement>("button")?.focus();
  }, [choosing]);

  // Rows moved to another folder: focus, left with nowhere to be, to the
  // row now where the first of them was, or the list's own button.
  const header = useRef<HTMLDivElement>(null);
  /** Focus to the row now at `index`, or the list's own button if there is none. */
  const focusRowAt = (index: number) => {
    refocusAt.current = null;
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-note-row]");
    const row = rows?.[Math.min(index, rows.length - 1)];
    (row ?? header.current?.querySelector<HTMLElement>("button"))?.focus();
  };
  useEffect(() => {
    const at = refocusAt.current;
    if (at === null) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    focusRowAt(at);
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
    if (note.pinned) {
      // Among the pinned, in every list, by its place among them.
      placing.current = placing.current
        .then(() =>
          placePinned(
            note.noteId,
            others.map((each) => each.noteId),
            index,
          ),
        )
        .catch(() => {});
      return;
    }
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
    if (!note || !(manual || note.pinned)) return;
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

  // Its notes' drags, told apart from the folder tree's.
  const owner = useId();
  // Dragged to a folder with a mouse; a finger drags only where notes are
  // placed by hand, as the folders are in a drawer then.
  const fine = useMediaQuery("(pointer: fine)");
  /** The notes a drag takes along. */
  const dragged = (active: Active) => {
    const data = dragData(active);
    return data?.kind === "note" ? withChosen(data.noteId) : [];
  };

  /** Opens a row's menu, as a long press would, where it is. */
  const openMenu = (noteId: string) => {
    const row = list.current?.querySelector<HTMLElement>(`[data-note-row="${noteId}"]`);
    if (!row) return;
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
  };

  const onDragEnd = ({ active, over, delta, activatorEvent }: DragEndEvent) => {
    const target = dragData(over);
    if (target?.kind === "into") {
      void moveTo(dragged(active), target.folderId);
      return;
    }
    // Into the sidebar, in no folder.
    if (target?.kind === "root") {
      void moveTo(dragged(active), null);
      return;
    }
    // A finger held on it and let go without moving it: its menu, as a long
    // press anywhere else gives.
    if (activatorEvent && "touches" in activatorEvent && Math.hypot(delta.x, delta.y) < 8) {
      openMenu(String(active.id));
      return;
    }
    if (dragged(active).length > 1) return;
    const drop = dropOf(active.id, over?.id);
    if (drop) place(drop.note, drop.index);
  };

  /** A drag of this list's notes going on. */
  const draggingNow = useRef(false);

  useWorkspaceDrag(owner, {
    // A folder under the pointer, first; then, placed by hand, a note alone
    // goes among those of its own kind, pinned or not, so that the others
    // do not make room for a drop that would not move it: the nearest of
    // them, so that one let go of past the list (over the phone's tab bar,
    // say) goes to the end it was taken to; but not one let go of over the
    // folders beside it.
    collide: (args) => {
      const folders = shownUnderPointer(
        pointerWithin({
          ...args,
          droppableContainers: args.droppableContainers.filter(
            (container) => {
              const kind = dragData(container)?.kind;
              return kind === "into" || kind === "root";
            },
          ),
        }),
        args,
      );
      if (folders.length > 0) return folders;
      const taken = dragged(args.active);
      // Placed by hand: all of them where the list is so ordered, and the
      // pinned ones whatever its order is.
      if (!(manual || taken[0]?.pinned) || taken.length > 1) return [];
      const box = list.current?.getBoundingClientRect();
      const x = args.pointerCoordinates?.x;
      if (box && x !== undefined && (x < box.left || x > box.right)) return [];
      const pinned = notes.find((each) => each.noteId === args.active.id)?.pinned;
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => {
          const data = dragData(container);
          return (
            data?.owner === owner &&
            notes.find((each) => each.noteId === container.id)?.pinned === pinned
          );
        }),
      });
    },
    onDragStart: () => {
      draggingNow.current = true;
    },
    onDragEnd: (event) => {
      draggingNow.current = false;
      onDragEnd(event);
    },
    onDragCancel: () => {
      draggingNow.current = false;
    },
    // dnd-kit announces drag progress to screen readers in English by default.
    announcements: {
      onDragStart: ({ active }) => {
        const taken = dragged(active);
        return taken.length > 1
          ? `${taken.length} 件のメモをつかみました。`
          : `${nameOf(active.id)}をつかみました。`;
      },
      onDragOver: ({ over }) => {
        if (!over) return undefined;
        const kind = dragData(over)?.kind;
        if (kind === "root") return "いちばん上の階層の上です。";
        return kind === "into"
          ? "フォルダの上です。"
          : `${nameOf(over.id)}の位置です。`;
      },
      onDragEnd: ({ active, over }) =>
        dragData(over)?.kind === "into" ||
        dragData(over)?.kind === "root" ||
        (dragged(active).length === 1 && dropOf(active.id, over?.id))
          ? "移動しました。"
          : "移動をやめました。",
      onDragCancel: () => "移動をやめました。",
    },
    overlay: (active) => {
      const taken = dragged(active);
      return (
        <div className="max-w-64 truncate rounded-md border bg-card px-3 py-2 text-sm font-medium shadow-lg">
          {taken.length > 1 ? `${taken.length} 件のメモ` : nameOf(active.id)}
        </div>
      );
    },
  });

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

  /** A row's menu: move it (and those chosen with it), or choose it. */
  const menuOf = (note: Note) => {
    const taken = withChosen(note.noteId);
    const allPinned = taken.every((each) => each.pinned);
    // Those it changes: the pinned ones to unpin, or the others to pin.
    const changing = taken.filter((each) => each.pinned === allPinned);
    return (
      <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <ContextMenuItem disabled={busy} onSelect={() => openDialog(() => pickFolderFor(taken))}>
          <FileInput className="size-4" aria-hidden />
          {taken.length > 1 ? `${taken.length} 件のメモを移動` : t.action.move}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void pinAll(changing, !allPinned, note.noteId)}>
          {allPinned ? (
            <PinOff className="size-4" aria-hidden />
          ) : (
            <Pin className="size-4" aria-hidden />
          )}
          {changing.length > 1
            ? allPinned
              ? `${changing.length} 件のピン留めを外す`
              : `${changing.length} 件をピン留め`
            : allPinned
              ? t.action.unpin
              : t.action.pin}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => toggleChosen(note.noteId, true)}>
          <ListChecks className="size-4" aria-hidden />
          {chosen.has(note.noteId) ? "選択を外す" : "選択"}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  };

  const rowProps = (note: Note) => ({
    note,
    selected: note.noteId === selectedNoteId,
    editing: note.noteId === editing,
    choosing,
    chosen: chosen.has(note.noteId),
    hintId,
    menu: menuOf(note),
    onSelect: onRowSelect,
    onStartRename: setEditing,
    onEndRename: (noteId: string, byKeyboard: boolean) => {
      if (byKeyboard) refocus.current = noteId;
      setEditing(null);
    },
    onArrow,
    onNudge: manual || note.pinned ? nudge : undefined,
    shownAt: order === "created" ? (createdAt(note.noteId) ?? note.updatedAt) : note.updatedAt,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        // Not one closing the row's menu or the move dialog, which are
        // drawn elsewhere but pass their keys up through here.
        if (!event.currentTarget.contains(event.target as Node)) return;
        // Not one ending a drag, which dnd-kit takes as cancelling it.
        if (event.key === "Escape" && choosing && editing === null && !draggingNow.current) {
          focusNext.current = "header";
          stopChoosing();
        }
      }}
    >
      {/* Said as it changes, kept here so that the first count is said too. */}
      <p className="sr-only" aria-live="polite">
        {choosing ? `${chosen.size} 件を選択` : ""}
      </p>
      {choosing ? (
        <div
          key="choosing"
          role="toolbar"
          aria-label="選択したメモ"
          className={cn(
            "flex items-center justify-between gap-2 border-b bg-background px-4 py-2",
            // On a phone, where the page scrolls, above the tab bar, in reach
            // wherever the list is scrolled to.
            "max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] max-md:z-30 max-md:border-t max-md:border-b-0",
          )}
        >
          <h2 className="min-w-0 truncate text-sm font-semibold">{chosen.size} 件を選択</h2>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const all = new Set(ids);
                setChoice({ ...choice, ids: all, on: true, base: all });
              }}
            >
              すべて選択
            </Button>
            <Button
              size="sm"
              disabled={chosen.size === 0 || busy}
              onClick={() => pickFolderFor(notes.filter((note) => chosen.has(note.noteId)))}
            >
              <FileInput className="size-4" aria-hidden />
              移動
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="選択をやめる"
              onClick={() => {
                focusNext.current = "header";
                stopChoosing();
              }}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : (
        <div
          key="header"
          ref={header}
          className="flex items-center justify-between gap-2 border-b px-4 py-3"
        >
          <h2 className="min-w-0 truncate text-sm font-semibold">{heading}</h2>
          <div className="flex shrink-0 items-center">
            {notes.length > 0 ? (
              <Button
                size="icon"
                variant="ghost"
                aria-label="メモを選択"
                onClick={() => {
                  focusNext.current = "rows";
                  setChoice({ ...unchosen(listKey), on: true });
                }}
              >
                <ListChecks className="size-4" aria-hidden />
              </Button>
            ) : null}
            {/* The pinned are in their own order, placed by hand. */}
            {pinnedOnly ? null : (
              <OrderMenu order={order} manualAllowed={folderId !== null} onChange={setOrder} />
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label={t.action.newNote}
              onClick={async () => {
                const id = await newNote();
                if (id) onSelectNote(id);
              }}
            >
              <FilePlus2 className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t.templates.fromTemplate}
              onClick={() => setPicking(true)}
            >
              <LayoutTemplate className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}
      <TemplatePicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(templateId) => void fromTemplate(templateId)}
        onEdit={() => openFolder(TEMPLATES_FOLDER_ID)}
      />

      {notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
          <p className="text-sm">{pinnedOnly ? "ピン留めしたメモはありません" : t.empty.noNotes}</p>
          <p className="text-xs">
            {pinnedOnly
              ? "メモのメニューの「ピン留め」で、どのフォルダのメモもここに集まります。"
              : t.empty.noNotesHint}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={async () => {
              const id = await newNote();
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
            {choosing
              ? "スペースで選択、もう一度で選択を外します。Escape で選択をやめます。"
              : "上下の矢印キーで移動、Enter でタイトルを変更、スペースで開きます。"}
            {choosing
              ? ""
              : manual
                ? "Option（Alt）と上下の矢印キーで並べ替えます。"
                : notes.some((note) => note.pinned)
                  ? "ピン留めしたメモは、Option（Alt）と上下の矢印キーで並べ替えます。"
                  : ""}
            Shift＋F10 で移動やピン留め、選択のメニューを開きます。
          </p>
          <p className="sr-only" aria-live="polite">
            {spoken}
          </p>
          {/* Room below for the bar that chooses, on a phone. */}
          <div ref={list} className={cn(choosing && "max-md:pb-14")}>
            {/* Placed by hand: all of them where the list is so ordered, and
                the pinned ones (first) whatever its order is. The others
                dragged to a folder only, with a mouse. */}
            <SortableContext
              items={manual ? ids : notes.filter((note) => note.pinned).map((note) => note.noteId)}
              strategy={verticalListSortingStrategy}
            >
              {notes.map((note) =>
                manual || note.pinned ? (
                  <SortableNoteRow key={note.noteId} owner={owner} {...rowProps(note)} />
                ) : fine ? (
                  <DraggableNoteRow key={note.noteId} owner={owner} {...rowProps(note)} />
                ) : (
                  <NoteRow key={note.noteId} {...rowProps(note)} />
                ),
              )}
            </SortableContext>
          </div>
        </ScrollArea>
      )}

      <FolderPicker
        open={moving !== null}
        title={moving && moving.length > 1 ? `${moving.length} 件のメモを移動` : "メモを移動"}
        rootLabel={t.action.topLevel}
        onOpenChange={(open) => !open && setMoving(null)}
        // Back to the row it was opened for (its menu item is gone), or, if
        // that has gone, to where focus goes once rows have (see refocusAt).
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const row = pickedFor.current
            ? list.current?.querySelector<HTMLElement>(`[data-note-row="${pickedFor.current}"]`)
            : null;
          if (row) row.focus();
          // Moved already, as it went: to the row now in its place.
          else if (refocusAt.current !== null) focusRowAt(refocusAt.current);
          else header.current?.querySelector<HTMLElement>("button")?.focus();
        }}
        onPick={(to) => {
          const moved = moving;
          setMoving(null);
          if (moved) void moveTo(moved, to);
        }}
      />
    </div>
  );
}
