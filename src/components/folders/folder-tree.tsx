"use client";

import { type DragEndEvent, pointerWithin } from "@dnd-kit/core";

import {
  ChevronRight,
  FileLock,
  FileText,
  Folder as FolderIcon,
  FolderInput,
  FolderLock,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Inbox,
  CalendarDays,
  LayoutTemplate,
  Lock,
  Loader2,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFolderTree, useNote, useNotesByFolder, useTopLevelNotes } from "@/lib/hooks/data";
import { LOCKED_LABEL, useNoteTitle, useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { useNoteOrders } from "@/lib/hooks/use-note-order";
import { orderNotes } from "@/lib/note-order";
import { useTreeOpen } from "@/lib/store/tree-open";
import { STAND_IN_CLASS, noteName } from "@/lib/note-name";
import { t } from "@/lib/i18n/ja";
import { useMediaQuery } from "@/lib/hooks/use-client-value";
import { useMenuDialog } from "@/lib/hooks/use-menu-dialog";
import { useLockProgress } from "@/lib/store/lock-progress";
import { type FolderLockKind, folderLockKind, lockCoverage } from "@/lib/vault/model";
import { useLockActions } from "@/components/vault/use-lock-actions";
import { between } from "@/lib/sortkey";
import { canMoveFolder, findNode, flattenTree, siblingsOf } from "@/lib/tree";
import { db } from "@/lib/db";
import {
  createFolder,
  moveFolder,
  moveNote,
  renameFolder,
  renameNote,
  setFolderTrashed,
  setNotePinned,
  setNoteTrashed,
} from "@/lib/sync/mutations";
import type { FolderNode, Note } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  FolderDragButton,
  FolderRowDropZones,
  NoteDragButton,
  NoteRowDropZone,
  RootDropZone,
} from "@/components/folders/folder-drag";
import { FolderPicker } from "@/components/folders/folder-picker";
import { RenameDialog } from "@/components/folders/rename-dialog";
import { InlineRename } from "@/components/shell/inline-rename";
import { dragData, shownUnderPointer, useWorkspaceDrag } from "@/components/shell/workspace-dnd";

/** Read out with each folder row, so the keys are discoverable. */
const FOLDER_KEYS_HINT =
  "上下の矢印キーで移動、右と左の矢印キーで開閉します。Enter で名前を変更、スペースで開きます。Option（Alt）と上下の矢印キーで並べ替えます。";

/**
 * A row of the tree: a folder, or a note: kept at the top level, in no
 * folder (at depth 0), or, shown as an explorer shows files, in its folder.
 */
type Row = { kind: "folder"; node: FolderNode } | { kind: "note"; note: Note; depth: number };
/** What is at the top level, in order, with the sort key that orders it. */
type TopItem = ({ kind: "folder"; node: FolderNode } | { kind: "note"; note: Note }) & { key: string };

/** A row's own id among every row's, folders' and notes'. */
const rowKey = (row: Row | TopItem) => (row.kind === "folder" ? `f:${row.node.folderId}` : `n:${row.note.noteId}`);

/**
 * The top level in order: the folders but Inbox (shown first whatever its
 * key) and the notes kept there, one order by their sort keys, a folder
 * first where two are the same.
 */
export function topLevelOrder(tree: FolderNode[], notes: Note[]): TopItem[] {
  const items: TopItem[] = [
    ...tree
      .filter((node) => node.system === null)
      .map((node) => ({ kind: "folder" as const, node, key: node.sortKey })),
    ...notes.map((note) => ({ kind: "note" as const, note, key: note.sortKey })),
  ];
  return items.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1,
  );
}

type Props = {
  /**
   * Each folder's notes shown inside it, as VS Code's explorer shows files: a
   * folder's row opens and closes it rather than showing its notes beside.
   */
  explorer?: boolean;
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  /** The note open, to show which of those kept in the sidebar it is. */
  selectedNoteId?: string | null;
  /** Opens a note of the tree, in its folder (null: none); with null, closes the one open. */
  onOpenNote?: (noteId: string | null, folderId?: string | null) => void;
  /** Selects a new folder without dismissing the panel it was created in. */
  onCreated?: (folderId: string) => void;
  /** Set when this tree lives inside the mobile drawer. */
  menuContainer?: HTMLElement | null;
};

export function FolderTree({
  explorer = false,
  selectedFolderId,
  onSelect,
  selectedNoteId = null,
  onOpenNote = () => {},
  onCreated = onSelect,
  menuContainer,
}: Props) {
  const tree = useFolderTree();
  const topNotes = useTopLevelNotes();
  const top = useMemo(() => topLevelOrder(tree, topNotes), [tree, topNotes]);
  // Each folder's notes, in the order its list is set to on this device.
  const notesByFolder = useNotesByFolder(explorer);
  const orderOf = useNoteOrders();
  const folderNotes = useMemo(() => {
    const ordered = new Map<string, Note[]>();
    for (const [folderId, notes] of notesByFolder) {
      const order = orderOf(folderId);
      const names =
        order === "title"
          ? new Map(
              notes.map((note) => [
                note.noteId,
                note.locked ? LOCKED_LABEL : noteName(note.title, note.preview).text,
              ]),
            )
          : undefined;
      ordered.set(folderId, orderNotes(notes, order, names));
    }
    return ordered;
  }, [notesByFolder, orderOf]);
  const notesIn = (folderId: string) => folderNotes.get(folderId) ?? [];
  const { moveNoteTo, toggleNoteLock, createNoteIn } = useLockActions();
  const [movingNote, setMovingNote] = useState<Note | null>(null);
  // A note kept in the sidebar being renamed: in place (Enter), or in the
  // dialog its menu opens, as a folder is.
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [renamingNote, setRenamingNote] = useState<{ noteId: string; title: string } | null>(null);
  const { toggleFolderLock, moveFolderTo } = useLockActions();
  const busy = useLockProgress((s) => s.busy);
  // Which lock covers each folder, its own or a parent's.
  const coverage = useMemo(() => lockCoverage(allNodes(tree)), [tree]);
  const expanded = useTreeOpen((s) => s.open);
  const toggle = useTreeOpen((s) => s.toggle);
  const expand = useTreeOpen((s) => s.expand);
  const [renaming, setRenaming] = useState<FolderNode | null>(null);
  const [moving, setMoving] = useState<FolderNode | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // The row being renamed in place, as a file explorer does on Enter.
  const [editing, setEditing] = useState<string | null>(null);
  const hintId = useId();

  // A row to put focus back on once it is on screen again: after an in-place
  // rename, and after a reorder, which re-sorts the rows and can drop focus.
  // The tree only changes when the local database does, so waiting for it to
  // change is waiting for the move to land.
  const list = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  /** A row's button, by its row key. */
  const rowElement = (key: string) => {
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    return list.current?.querySelector<HTMLElement>(
      kind === "f" ? `[data-folder-row="${id}"]` : `[data-tree-note="${id}"]`,
    );
  };
  useEffect(() => {
    const key = refocus.current;
    if (!key || editing !== null || editingNote !== null) return;
    const row = rowElement(key);
    if (!row) return;
    refocus.current = null;
    row.focus();
  }, [tree, topNotes, editing, editingNote]);

  const { openDialog, onCloseAutoFocus } = useMenuDialog();

  // Dragging a row inside a scrolling drawer fights the scroll on a phone, and
  // the move dialog covers the same need there, so this is a pointer feature.
  const canDrag = useMediaQuery("(pointer: fine)");

  // Its folders' drags and drop targets, told apart from the other tree's
  // (the drawer's, on a phone) and from the note list's.
  const owner = useId();
  const nameOf = (folderId: string | undefined) =>
    (folderId && findNode(tree, folderId)?.name) || "フォルダ";
  const noteOf = (noteId: string | undefined) =>
    topNotes.find((note) => note.noteId === noteId) ??
    [...notesByFolder.values()].flat().find((note) => note.noteId === noteId);
  const draggedFolder = (active: { data: { current?: unknown } }) => {
    const data = dragData(active);
    return data?.kind === "folder" ? data.folderId : undefined;
  };
  const draggedNote = (active: { data: { current?: unknown } }) => {
    const data = dragData(active);
    return data?.kind === "note" ? data.noteId : undefined;
  };
  const dragName = (active: { data: { current?: unknown } }) => {
    const note = noteOf(draggedNote(active));
    return note ? noteName(note.title, note.locked ? null : note.preview).text : nameOf(draggedFolder(active));
  };

  /**
   * Where something put just above `target` (a folder's or a note's row)
   * goes: among the target's siblings, `moving` (its own row key) left out.
   * At the top level, folders and notes are one order.
   */
  const placeBefore = (
    target: { folderId: string } | { noteId: string },
    moving: string,
  ): { parentId: string | null; sortKey: string } | null => {
    const anchorKey = "noteId" in target ? `n:${target.noteId}` : `f:${target.folderId}`;
    const anchorFolder = "folderId" in target ? findNode(tree, target.folderId) : null;
    if ("folderId" in target && !anchorFolder) return null;
    if (anchorFolder && anchorFolder.system !== null) return null;
    if (!anchorFolder || anchorFolder.parentId === null) {
      const items = top.filter((item) => rowKey(item) !== moving);
      const index = items.findIndex((item) => rowKey(item) === anchorKey);
      if (index < 0) return null;
      return { parentId: null, sortKey: between(items[index - 1]?.key ?? null, items[index]!.key) };
    }
    // Not Inbox: it is shown first whatever its key, so it is not the one
    // before the first folder after it.
    const siblings = siblingsOf(tree, anchorFolder.folderId).filter(
      (f) => `f:${f.folderId}` !== moving && f.system === null,
    );
    const index = siblings.findIndex((f) => f.folderId === anchorFolder.folderId);
    const previous = index > 0 ? siblings[index - 1]!.sortKey : null;
    return { parentId: anchorFolder.parentId, sortKey: between(previous, anchorFolder.sortKey) };
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const target = dragData(over);
    if (!target) return;
    const noteId = draggedNote(active);
    if (noteId) {
      await dropNote(noteId, target);
      return;
    }
    const sourceId = draggedFolder(active);
    if (!sourceId) return;

    const folders = await db().folders.toArray();
    if (target.kind === "root") {
      if (canMoveFolder(folders, sourceId, null)) await moveFolderTo(sourceId, null);
      return;
    }
    if (target.kind === "into") {
      const targetId = target.folderId;
      if (targetId === sourceId) return;
      if (!canMoveFolder(folders, sourceId, targetId)) {
        toast.error("そのフォルダの中には移動できません。");
        return;
      }
      await moveFolderTo(sourceId, targetId);
      expand([targetId]);
      return;
    }
    if (target.kind !== "before" && target.kind !== "beforeNote") return;
    if (target.kind === "before" && target.folderId === sourceId) return;
    // Become a sibling of the target, just above it.
    const place = placeBefore(target, `f:${sourceId}`);
    if (!place) return;
    if (!canMoveFolder(folders, sourceId, place.parentId)) {
      toast.error("そのフォルダの中には移動できません。");
      return;
    }
    await moveFolderTo(sourceId, place.parentId, place.sortKey);
  };

  /**
   * A note of the tree, dropped: into a folder (locked first, as a move there
   * does), or among the top level's folders and notes.
   */
  const dropNote = async (noteId: string, target: NonNullable<ReturnType<typeof dragData>>) => {
    const note = noteOf(noteId);
    if (!note) return;
    if (target.kind === "into") {
      if (note.folderId !== target.folderId) await moveNoteTo(note, target.folderId);
      return;
    }
    if (target.kind === "root") {
      if (note.folderId === null) await moveNote(noteId, null);
      else await moveNoteTo(note, null);
      return;
    }
    if (target.kind !== "before" && target.kind !== "beforeNote") return;
    if (target.kind === "beforeNote" && target.noteId === noteId) return;
    const place = placeBefore(target, `n:${noteId}`);
    if (!place) return;
    // Above a folder inside another: into that one, as the move would be.
    if (place.parentId !== null) {
      if (note.folderId !== place.parentId) await moveNoteTo(note, place.parentId);
    }
    // To the top level, which no lock covers: a move there is only a move.
    else await moveNote(noteId, null, place.sortKey);
  };

  // A small threshold so a plain click still selects the folder (see
  // WorkspaceDnd). There is no keyboard drag: Enter renames and Space opens,
  // as in VS Code, reordering has its own keys, and moving into another
  // folder has the move dialog.
  useWorkspaceDrag(owner, {
    // Its own targets only, under the pointer.
    collide: (args) =>
      shownUnderPointer(
        pointerWithin({
          ...args,
          droppableContainers: args.droppableContainers.filter(
            (container) => dragData(container)?.owner === owner,
          ),
        }),
        args,
      ),
    onDragStart: ({ active }) => setDragging(draggedFolder(active) ?? draggedNote(active) ?? null),
    onDragEnd: (event) => void onDragEnd(event),
    onDragCancel: () => setDragging(null),
    // dnd-kit announces drag progress to screen readers in English by default.
    announcements: {
      onDragStart: ({ active }) => `${dragName(active)} をつかみました。`,
      onDragOver: ({ over }) => (over ? "移動先の上にいます。" : undefined),
      onDragEnd: ({ over }) => (over ? "移動しました。" : "移動をやめました。"),
      onDragCancel: () => "移動をやめました。",
    },
    overlay: (active) => (
      <div className="rounded-md border bg-card px-2 py-1.5 text-sm shadow-lg">
        {dragName(active)}
      </div>
    ),
  });

  // Inbox first, then the top level in order, each folder with what is open
  // inside it: its folders, then, as an explorer shows files, its notes.
  const system = tree.filter((node) => node.system !== null);
  const walk = (nodes: FolderNode[]): Row[] =>
    explorer
      ? nodes.flatMap((node): Row[] => [
          { kind: "folder", node },
          ...(expanded.has(node.folderId)
            ? [
                ...walk(node.children),
                ...notesIn(node.folderId).map((note): Row => ({ kind: "note", note, depth: node.depth + 1 })),
              ]
            : []),
        ])
      : flattenTree(nodes, expanded).map((node) => ({ kind: "folder" as const, node }));
  const rows: Row[] = [
    ...walk(system),
    ...top.flatMap((item): Row[] =>
      item.kind === "folder" ? walk([item.node]) : [{ kind: "note", note: item.note, depth: 0 }],
    ),
  ];
  /** Whether a folder has anything to open: folders, or, here, notes. */
  const hasRows = (node: FolderNode) => node.children.length > 0 || notesIn(node.folderId).length > 0;

  // The note open (or else the folder) shown, its folders opened, as VS Code
  // shows the file open: once for each, so that one closed again stays so.
  const openNoteFolder = useNote(explorer ? selectedNoteId : null)?.folderId ?? null;
  const shownFolder = selectedNoteId ? openNoteFolder : selectedFolderId;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!explorer || !shownFolder) return;
    const key = `${selectedNoteId ?? ""}:${shownFolder}`;
    if (revealed.current === key) return;
    const path: string[] = [];
    for (let node = findNode(tree, shownFolder); node; ) {
      path.push(node.folderId);
      node = node.parentId ? findNode(tree, node.parentId) : null;
    }
    // Not loaded yet: once it is.
    if (path.length === 0) return;
    revealed.current = key;
    expand(path);
  }, [explorer, shownFolder, selectedNoteId, tree, expand]);

  /** A new note in a folder, opened to be written in, the folder opened to show it. */
  const newNoteIn = async (folderId: string) => {
    const id = await createNoteIn(folderId);
    if (!id) return;
    expand([folderId]);
    onOpenNote(id, folderId);
  };

  /** Moves a row one place up or down among its siblings: at the top level, folders and notes alike. */
  const nudge = async (row: Row, direction: -1 | 1) => {
    // A folder's notes are in the order its list is set to.
    if (row.kind === "note" && row.note.folderId !== null) return;
    if (row.kind === "folder" && row.node.parentId !== null) {
      const node = row.node;
      const siblings = siblingsOf(tree, node.folderId);
      const index = siblings.findIndex((f) => f.folderId === node.folderId);
      const neighbour = siblings[index + direction];
      if (index < 0 || !neighbour) return;
      const beyond = siblings[index + direction * 2];
      const [before, after] =
        direction < 0
          ? [beyond?.sortKey ?? null, neighbour.sortKey]
          : [neighbour.sortKey, beyond?.sortKey ?? null];
      refocus.current = rowKey(row);
      await moveFolder(node.folderId, node.parentId, between(before, after));
      return;
    }
    const index = top.findIndex((item) => rowKey(item) === rowKey(row));
    const neighbour = top[index + direction];
    if (index < 0 || !neighbour) return;
    const beyond = top[index + direction * 2];
    const [before, after] =
      direction < 0 ? [beyond?.key ?? null, neighbour.key] : [neighbour.key, beyond?.key ?? null];
    refocus.current = rowKey(row);
    if (row.kind === "folder") await moveFolder(row.node.folderId, null, between(before, after));
    else await moveNote(row.note.noteId, null, between(before, after));
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: Row, renamable: boolean) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && renamable) {
      // Stops the button's own Enter, which would open the folder (or the
      // note) instead.
      event.preventDefault();
      if (row.kind === "folder") setEditing(row.node.folderId);
      else setEditingNote(row.note.noteId);
    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (row.kind === "note" || row.node.system === null) {
        void nudge(row, event.key === "ArrowUp" ? -1 : 1);
      }
    } else if (!event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (navigate(event.key, row)) event.preventDefault();
    }
  };

  /**
   * Arrow keys walk the tree as VS Code's explorer does: up and down move
   * between visible rows, right opens a folder and then steps into it, and
   * left closes it and then steps out to its parent. They move focus only;
   * Space is what shows a folder's notes, or opens a note.
   */
  const navigate = (key: string, row: Row): boolean => {
    const index = rows.findIndex((each) => rowKey(each) === rowKey(row));
    switch (key) {
      case "ArrowUp":
        focusKey(rows[index - 1]);
        return true;
      case "ArrowDown":
        focusKey(rows[index + 1]);
        return true;
      case "Home":
        focusKey(rows[0]);
        return true;
      case "End":
        focusKey(rows.at(-1));
        return true;
    }
    if (row.kind === "note") {
      // Out to its folder, as from a folder to its parent.
      if (key === "ArrowLeft" && row.note.folderId !== null) focusRow(row.note.folderId);
      return key === "ArrowRight" || key === "ArrowLeft";
    }
    const node = row.node;
    const hasChildren = hasRows(node);
    const isOpen = expanded.has(node.folderId);
    switch (key) {
      case "ArrowRight":
        if (hasChildren && !isOpen) toggle(node.folderId);
        // The first of what is inside: the row after it.
        else if (hasChildren) focusKey(rows[index + 1]);
        return true;
      case "ArrowLeft":
        if (hasChildren && isOpen) toggle(node.folderId);
        else focusRow(node.parentId ?? undefined);
        return true;
      default:
        return false;
    }
  };

  const focusKey = (row: Row | undefined) => {
    if (row) rowElement(rowKey(row))?.focus();
  };
  const focusRow = (folderId: string | undefined) => {
    if (folderId) rowElement(`f:${folderId}`)?.focus();
  };

  return (
    <>
      <p id={hintId} className="sr-only">
        {FOLDER_KEYS_HINT}
      </p>
      <div ref={list} className="flex flex-col gap-0.5">
        {rows.map((row) => {
          if (row.kind === "note") {
            const { note } = row;
            return (
              <TreeNoteRow
                key={note.noteId}
                owner={owner}
                note={note}
                depth={row.depth}
                inFolder={note.folderId !== null}
                selected={selectedNoteId === note.noteId}
                canDrag={canDrag && dragging !== note.noteId}
                describedBy={hintId}
                menuContainer={menuContainer}
                onCloseAutoFocus={onCloseAutoFocus}
                onOpen={() => onOpenNote(note.noteId, note.folderId)}
                onKeyDown={(event, renamable) => onRowKeyDown(event, row, renamable)}
                editing={editingNote === note.noteId}
                onRename={(value) => renameNote(note.noteId, value)}
                onRenamed={(byKeyboard) => {
                  if (byKeyboard) refocus.current = rowKey(row);
                  setEditingNote(null);
                }}
                onRenameInDialog={(title) => openDialog(() => setRenamingNote({ noteId: note.noteId, title }))}
                onMove={() => openDialog(() => setMovingNote(note))}
                onToggleLock={(title, returnFocus) =>
                  new Promise<void>((done) =>
                    openDialog(() => void toggleNoteLock(note, title, returnFocus).finally(done)),
                  )
                }
                onTrashed={() => {
                  if (selectedNoteId === note.noteId) onOpenNote(null);
                }}
              />
            );
          }
          const { node } = row;
          const selected = selectedFolderId === node.folderId && selectedNoteId === null;
          const hasChildren = hasRows(node);
          // Inbox and the folder of templates: kept where they are, never locked or trashed.
          const isSystem = node.system !== null;
          const label = node.name ?? (node.nameSealed ? "ロックされたフォルダ" : null);
          const lockKind = isSystem ? "none" : folderLockKind(node.folderId, coverage);
          const coverName =
            lockKind === "inherited"
              ? (findNode(tree, coverage.get(node.folderId)!)?.name ?? "ロックされたフォルダ")
              : null;

          return (
            <FolderRowDropZones
              key={node.folderId}
              owner={owner}
              folderId={node.folderId}
              disabled={!canDrag || dragging === node.folderId}
            >
              <div
                className={cn(
                  "group flex items-center gap-1 rounded-md pr-1 text-sm",
                  // The keyboard focus is drawn round the whole row, where the
                  // selection highlight is, rather than round the name alone.
                  "has-[[data-folder-row]:focus-visible]:ring-ring has-[[data-folder-row]:focus-visible]:ring-2",
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
                style={{ paddingLeft: `${node.depth * 12}px` }}
              >
                <button
                  type="button"
                  aria-label={
                    hasChildren
                      ? `${label ?? "フォルダ"} を${expanded.has(node.folderId) ? "閉じる" : "開く"}`
                      : undefined
                  }
                  aria-expanded={hasChildren ? expanded.has(node.folderId) : undefined}
                  tabIndex={hasChildren ? undefined : -1}
                  onClick={() => hasChildren && toggle(node.folderId)}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded",
                    !hasChildren && "invisible",
                  )}
                >
                  <ChevronRight
                    className={cn(
                      "size-3.5 transition-transform",
                      expanded.has(node.folderId) && "rotate-90",
                    )}
                    aria-hidden
                  />
                </button>

                {editing === node.folderId ? (
                  // Not inside the button: a field in a button would have its
                  // Space and Enter taken by the button.
                  <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
                    <FolderGlyph
                      system={node.system}
                      lock={lockKind}
                      busy={busy.has(node.folderId)}
                      open={hasChildren && expanded.has(node.folderId)}
                    />
                    <InlineRename
                      initialValue={node.name ?? ""}
                      label="フォルダ名"
                      className="h-6"
                      onSubmit={(value) => renameFolder(node.folderId, value)}
                      onDone={(byKeyboard) => {
                        if (byKeyboard) refocus.current = rowKey(row);
                        setEditing(null);
                      }}
                    />
                  </div>
                ) : (
                  <FolderDragButton
                    owner={owner}
                    folderId={node.folderId}
                    disabled={!canDrag || isSystem}
                    // Opened and closed, as an explorer's folder is, or its
                    // notes shown in the list beside.
                    onClick={() => (explorer ? toggle(node.folderId) : onSelect(node.folderId))}
                    // A locked folder's name is unreadable until the vault is
                    // open, and there is nothing to edit in a placeholder.
                    onKeyDown={(event) => onRowKeyDown(event, row, node.name !== null)}
                    describedBy={hintId}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left outline-none"
                  >
                    {/* Every row carries a folder glyph. Without one, plain folders
                    were bare names and read no differently from notes. */}
                    <FolderGlyph
                      system={node.system}
                      lock={lockKind}
                      busy={busy.has(node.folderId)}
                      open={hasChildren && expanded.has(node.folderId)}
                    />
                    <span className="truncate">{label ?? "無題のフォルダ"}</span>
                    {lockKind !== "none" ? (
                      <span className="sr-only">
                        {lockKind === "own" ? "（ロック中）" : "（親フォルダでロック中）"}
                      </span>
                    ) : null}
                  </FolderDragButton>
                )}

                {explorer ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    aria-label={`${label ?? "フォルダ"} に${t.action.newNote}`}
                    onClick={() => void newNoteIn(node.folderId)}
                  >
                    <FilePlus className="size-3.5" aria-hidden />
                  </Button>
                ) : null}

                {/* Not modal: on a phone this menu lives inside the folder
                drawer, and two nested focus traps fight each other so the
                menu closes the moment it opens. */}
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      // A hover-only affordance is unreachable on a touch screen,
                      // so it stays visible wherever there is no hover.
                      className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                      aria-label={`${label ?? "フォルダ"} の操作`}
                    >
                      <MoreHorizontal className="size-3.5" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-44"
                    portalContainer={menuContainer}
                    onCloseAutoFocus={onCloseAutoFocus}
                  >
                    {explorer ? (
                      <DropdownMenuItem onSelect={() => void newNoteIn(node.folderId)}>
                        <FilePlus className="size-4" aria-hidden />
                        {t.action.newNote}
                      </DropdownMenuItem>
                    ) : null}
                    {/* Templates are its notes, not its folders'; so are the days'. */}
                    {node.system === "templates" || node.system === "journal" ? null : (
                      <DropdownMenuItem
                        onSelect={async () => {
                          const id = await createFolder({
                            parentId: node.folderId,
                            name: "新しいフォルダ",
                          });
                          expand([node.folderId]);
                          onCreated(id);
                        }}
                      >
                        <FolderPlus className="size-4" aria-hidden />
                        サブフォルダを追加
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => openDialog(() => setRenaming(node))}>
                      <Pencil className="size-4" aria-hidden />
                      名前を変更
                    </DropdownMenuItem>
                    {!isSystem ? (
                      <DropdownMenuItem onSelect={() => openDialog(() => setMoving(node))}>
                        <FolderInput className="size-4" aria-hidden />
                        別のフォルダへ移動
                      </DropdownMenuItem>
                    ) : null}
                    {/* Inbox is where quick notes land, so it is never locked:
                    every new note would have to wait for the vault. */}
                    {isSystem ? null : busy.has(node.folderId) ? (
                      <DropdownMenuItem disabled>
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                        処理中…
                      </DropdownMenuItem>
                    ) : lockKind === "inherited" ? (
                      // Covered by a parent's lock: that is the one to take off.
                      <DropdownMenuItem disabled>
                        <Lock className="size-4" aria-hidden />
                        親フォルダ「{coverName}」でロック中
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() =>
                          openDialog(() =>
                            void toggleFolderLock(
                              node,
                              list.current?.querySelector<HTMLElement>(
                                `[data-folder-row="${node.folderId}"]`,
                              ),
                            ),
                          )
                        }
                      >
                        {node.locked ? (
                          <LockOpen className="size-4" aria-hidden />
                        ) : (
                          <Lock className="size-4" aria-hidden />
                        )}
                        {node.locked ? "ロックを外す…" : "ロックする…"}
                      </DropdownMenuItem>
                    )}
                    {!isSystem ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={async () => {
                            await setFolderTrashed(node.folderId, true);
                            if (selected) onSelect(null);
                            toast("ゴミ箱に移動しました", {
                              action: {
                                label: "元に戻す",
                                onClick: () => void setFolderTrashed(node.folderId, false),
                              },
                            });
                          }}
                        >
                          <Trash2 className="size-4" aria-hidden />
                          ゴミ箱に移動
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </FolderRowDropZones>
          );
        })}

        <RootDropZone owner={owner} />

        <FolderPicker
          open={movingNote !== null}
          title="メモを移動"
          rootLabel={t.action.topLevel}
          onOpenChange={(open) => !open && setMovingNote(null)}
          onPick={async (folderId) => {
            const note = movingNote;
            setMovingNote(null);
            if (note) await moveNoteTo(note, folderId);
          }}
        />

        <FolderPicker
          open={moving !== null}
          title="フォルダを移動"
          rootLabel="いちばん上の階層"
          // A folder cannot be dropped inside itself or its own children.
          excludeSubtreeOf={moving?.folderId}
          onOpenChange={(open) => !open && setMoving(null)}
          onPick={async (parentId) => {
            const folder = moving;
            setMoving(null);
            if (folder) await moveFolderTo(folder.folderId, parentId);
          }}
        />

        <RenameDialog
          open={renamingNote !== null}
          title="メモの名前を変更"
          initialValue={renamingNote?.title ?? ""}
          onOpenChange={(open) => !open && setRenamingNote(null)}
          onSubmit={async (value) => {
            if (renamingNote) await renameNote(renamingNote.noteId, value);
            setRenamingNote(null);
          }}
        />

        <RenameDialog
          open={renaming !== null}
          title="フォルダ名を変更"
          initialValue={renaming?.name ?? ""}
          onOpenChange={(open) => !open && setRenaming(null)}
          onSubmit={async (value) => {
            if (renaming) await renameFolder(renaming.folderId, value);
            setRenaming(null);
          }}
        />
      </div>
    </>
  );
}

/**
 * The icon at the start of a folder row: Inbox, the templates', locked (its own lock, or a
 * small lock for one inherited from a parent), in progress, open or closed.
 */
function FolderGlyph({
  system,
  lock,
  busy = false,
  open,
}: {
  system: FolderNode["system"];
  lock: FolderLockKind;
  busy?: boolean;
  open: boolean;
}) {
  if (busy) return <Loader2 className="size-4 shrink-0 animate-spin opacity-70" aria-hidden />;
  if (system === "inbox") return <Inbox className="size-4 shrink-0 opacity-70" aria-hidden />;
  if (system === "templates") return <LayoutTemplate className="size-4 shrink-0 opacity-70" aria-hidden />;
  if (system === "journal") return <CalendarDays className="size-4 shrink-0 opacity-70" aria-hidden />;
  if (lock === "own") return <FolderLock className="size-4 shrink-0 opacity-70" aria-hidden />;
  const Icon = open ? FolderOpen : FolderIcon;
  return (
    <span className="relative inline-flex shrink-0">
      <Icon className="size-4 opacity-70" aria-hidden />
      {lock === "inherited" ? (
        <Lock className="bg-background absolute -right-1 -bottom-1 size-2.5 rounded-full" aria-hidden />
      ) : null}
    </span>
  );
}

/** Every node of the tree, open or not. */
function allNodes(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...allNodes(node.children)]);
}

/**
 * A note of the tree: kept in the sidebar, at the top level, or shown in its
 * folder. Opened by a click (Space from the keys), renamed in place by Enter
 * or from its menu, as a folder is, dragged into a folder, or, at the top
 * level, among the folders. Its name is its title: renamed here, the note's
 * own title is. Not while its title cannot be read (a locked note, the vault
 * closed). At the top level, locked, or its lock taken off, from its menu, as
 * from the note's own: it is in no folder, so its lock is its own.
 */
function TreeNoteRow({
  owner,
  note,
  depth,
  inFolder,
  selected,
  canDrag,
  describedBy,
  menuContainer,
  onCloseAutoFocus,
  onOpen,
  onKeyDown,
  editing,
  onRename,
  onRenamed,
  onRenameInDialog,
  onMove,
  onToggleLock,
  onTrashed,
}: {
  owner: string;
  note: Note;
  /** How far in it is: 0 at the top level. */
  depth: number;
  /** In a folder, in the order of that folder's list: not placed among the rows. */
  inFolder: boolean;
  selected: boolean;
  canDrag: boolean;
  describedBy: string;
  menuContainer?: HTMLElement | null;
  onCloseAutoFocus: (event: Event) => void;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, renamable: boolean) => void;
  editing: boolean;
  onRename: (value: string) => Promise<void> | void;
  onRenamed: (byKeyboard: boolean) => void;
  onRenameInDialog: (title: string) => void;
  onMove: () => void;
  /** Asks for the vault and locks the note, or takes its lock off; done when it has. */
  onToggleLock: (title: string | null, returnFocus: HTMLElement | null) => Promise<void>;
  onTrashed: () => void;
}) {
  const [locking, setLocking] = useState(false);
  const button = useRef<HTMLDivElement>(null);
  const title = useNoteTitle(note);
  const unlocked = useVaultUnlocked();
  const renamable = !note.locked || unlocked;
  // Its own title, to be changed: none (無題) is an empty one.
  const current = note.locked ? title : (note.title ?? "");
  const name = noteName(title, note.locked ? null : note.preview);
  const Icon = locking ? Loader2Note : note.locked ? FileLock : FileText;
  return (
    <NoteRowDropZone owner={owner} noteId={note.noteId} disabled={!canDrag || inFolder}>
      <div
        ref={button}
        className={cn(
          "group flex items-center gap-1 rounded-md pr-1 text-sm",
          "has-[[data-tree-note]:focus-visible]:ring-ring has-[[data-tree-note]:focus-visible]:ring-2",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        )}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {/* Where a folder's chevron is, so names line up. */}
        <span className="size-5 shrink-0" aria-hidden />
        {editing ? (
          // Not inside the button: a field in a button would have its Space
          // and Enter taken by the button.
          <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
            <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
            <InlineRename
              initialValue={current}
              label="メモの名前"
              className="h-6"
              onSubmit={onRename}
              onDone={onRenamed}
            />
          </div>
        ) : (
          <NoteDragButton
            owner={owner}
            noteId={note.noteId}
            disabled={!canDrag}
            onClick={onOpen}
            onKeyDown={(event) => onKeyDown(event, renamable)}
            describedBy={describedBy}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left outline-none"
          >
            <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
            <span className={cn("truncate", name.standIn && STAND_IN_CLASS)}>{name.text}</span>
            <span className="sr-only">（メモ{note.locked ? "、ロック中" : ""}）</span>
          </NoteDragButton>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
              aria-label={`${name.text} の操作`}
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-44"
            portalContainer={menuContainer}
            onCloseAutoFocus={onCloseAutoFocus}
          >
            <DropdownMenuItem onSelect={() => void setNotePinned(note.noteId, !note.pinned)}>
              {note.pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
              {note.pinned ? t.action.unpin : t.action.pin}
            </DropdownMenuItem>
            {renamable ? (
              <DropdownMenuItem onSelect={() => onRenameInDialog(current)}>
                <Pencil className="size-4" aria-hidden />
                名前を変更
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={onMove}>
              <FolderInput className="size-4" aria-hidden />
              {t.action.move}
            </DropdownMenuItem>
            {/* In a folder, its lock is the note's own menu's to change, as from its list. */}
            {inFolder ? null : locking ? (
              <DropdownMenuItem disabled>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                処理中…
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => {
                  setLocking(true);
                  void onToggleLock(
                    // The title is only known while it is readable.
                    renamable ? name.text : null,
                    button.current?.querySelector<HTMLElement>("[data-tree-note]") ?? null,
                  ).finally(() => setLocking(false));
                }}
              >
                {note.locked ? <LockOpen className="size-4" aria-hidden /> : <Lock className="size-4" aria-hidden />}
                {note.locked ? "ロックを外す…" : "ロックする…"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={async () => {
                await setNoteTrashed(note.noteId, true);
                onTrashed();
                toast("ゴミ箱に移動しました", {
                  action: { label: "元に戻す", onClick: () => void setNoteTrashed(note.noteId, false) },
                });
              }}
            >
              <Trash2 className="size-4" aria-hidden />
              {t.action.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </NoteRowDropZone>
  );
}

/** The note row's icon while its lock is being put on or taken off. */
function Loader2Note({ className }: { className?: string }) {
  return <Loader2 className={cn(className, "animate-spin")} aria-hidden />;
}
