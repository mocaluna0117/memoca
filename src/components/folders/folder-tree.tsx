"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

import {
  ChevronRight,
  Folder as FolderIcon,
  FolderInput,
  FolderLock,
  FolderOpen,
  FolderPlus,
  Inbox,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFolderTree } from "@/lib/hooks/data";
import { useMediaQuery } from "@/lib/hooks/use-client-value";
import { between } from "@/lib/sortkey";
import { canMoveFolder, findNode, flattenTree, siblingsOf } from "@/lib/tree";
import { db } from "@/lib/db";
import { createFolder, moveFolder, renameFolder, setFolderTrashed } from "@/lib/sync/mutations";
import type { FolderNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  FolderDragButton,
  FolderRowDropZones,
  RootDropZone,
} from "@/components/folders/folder-drag";
import { FolderPicker } from "@/components/folders/folder-picker";
import { RenameDialog } from "@/components/folders/rename-dialog";
import { InlineRename } from "@/components/shell/inline-rename";

/** Read out with each folder row, so the keys are discoverable. */
const FOLDER_KEYS_HINT =
  "上下の矢印キーで移動、右と左の矢印キーで開閉します。Enter で名前を変更、スペースで開きます。Option（Alt）と上下の矢印キーで並べ替えます。";

type Props = {
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  onRequestLock?: (folder: FolderNode) => void;
  /** Selects a new folder without dismissing the panel it was created in. */
  onCreated?: (folderId: string) => void;
  /** Set when this tree lives inside the mobile drawer. */
  menuContainer?: HTMLElement | null;
};

export function FolderTree({
  selectedFolderId,
  onSelect,
  onRequestLock,
  onCreated = onSelect,
  menuContainer,
}: Props) {
  const tree = useFolderTree();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
  useEffect(() => {
    const folderId = refocus.current;
    if (!folderId || editing !== null) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-folder-row="${folderId}"]`);
    if (!row) return;
    refocus.current = null;
    row.focus();
  }, [tree, editing]);

  // A closing menu puts focus back on its trigger. When the chosen item opens
  // a dialog, that pulls focus out of the dialog's field, so typing goes
  // nowhere and Enter cannot save. Those items set this to skip the return.
  const openingDialog = useRef(false);
  const openDialog = (open: () => void) => {
    openingDialog.current = true;
    open();
  };

  // Dragging a row inside a scrolling drawer fights the scroll on a phone, and
  // the move dialog covers the same need there, so this is a pointer feature.
  const canDrag = useMediaQuery("(pointer: fine)");

  const sensors = useSensors(
    // A small threshold so a plain click still selects the folder. There is no
    // keyboard drag: Enter renames and Space opens, as in VS Code, reordering
    // has its own keys, and moving into another folder has the move dialog.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // dnd-kit announces drag progress to screen readers in English by default.
  const nameOf = (id: string | number) => findNode(tree, String(id))?.name ?? "フォルダ";
  const announcements = {
    onDragStart: ({ active }: { active: { id: string | number } }) =>
      `${nameOf(active.id)} をつかみました。`,
    onDragOver: ({ over }: { over: { id: string | number } | null }) =>
      over ? "移動先の上にいます。" : undefined,
    onDragEnd: ({ over }: { over: { id: string | number } | null }) =>
      over ? "移動しました。" : "移動をやめました。",
    onDragCancel: () => "移動をやめました。",
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const sourceId = String(active.id);
    const target = String(over.id);

    const folders = await db().folders.toArray();
    if (target === "root") {
      if (canMoveFolder(folders, sourceId, null)) await moveFolder(sourceId, null);
      return;
    }

    const [mode, targetId] = target.split(":");
    if (targetId === sourceId) return;

    if (mode === "into") {
      if (!canMoveFolder(folders, sourceId, targetId!)) {
        toast.error("そのフォルダの中には移動できません。");
        return;
      }
      await moveFolder(sourceId, targetId!);
      setExpanded((current) => new Set(current).add(targetId!));
      return;
    }

    // "before": become a sibling of the target, just above it.
    const anchor = findNode(tree, targetId!);
    if (!anchor) return;
    const parentId = anchor.parentId;
    if (!canMoveFolder(folders, sourceId, parentId)) {
      toast.error("そのフォルダの中には移動できません。");
      return;
    }
    const siblings = siblingsOf(tree, targetId!).filter((f) => f.folderId !== sourceId);
    const index = siblings.findIndex((f) => f.folderId === targetId);
    const previous = index > 0 ? siblings[index - 1]!.sortKey : null;
    await moveFolder(sourceId, parentId, between(previous, anchor.sortKey));
  };

  const rows = flattenTree(tree, expanded);

  /** Moves a folder one place up or down among its siblings. */
  const nudge = async (node: FolderNode, direction: -1 | 1) => {
    const siblings = siblingsOf(tree, node.folderId);
    const index = siblings.findIndex((f) => f.folderId === node.folderId);
    const neighbour = siblings[index + direction];
    if (index < 0 || !neighbour) return;
    const beyond = siblings[index + direction * 2];
    const [before, after] =
      direction < 0
        ? [beyond?.sortKey ?? null, neighbour.sortKey]
        : [neighbour.sortKey, beyond?.sortKey ?? null];
    refocus.current = node.folderId;
    await moveFolder(node.folderId, node.parentId, between(before, after));
  };

  const onRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    node: FolderNode,
    renamable: boolean,
  ) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && renamable) {
      // Stops the button's own Enter, which would open the folder instead.
      event.preventDefault();
      setEditing(node.folderId);
    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (node.system !== "inbox") void nudge(node, event.key === "ArrowUp" ? -1 : 1);
    } else if (!event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (navigate(event.key, node)) event.preventDefault();
    }
  };

  /**
   * Arrow keys walk the tree as VS Code's explorer does: up and down move
   * between visible rows, right opens a folder and then steps into it, and
   * left closes it and then steps out to its parent. They move focus only;
   * Space is what shows a folder's notes.
   */
  const navigate = (key: string, node: FolderNode): boolean => {
    const index = rows.findIndex((row) => row.folderId === node.folderId);
    const hasChildren = node.children.length > 0;
    const isOpen = expanded.has(node.folderId);
    switch (key) {
      case "ArrowUp":
        focusRow(rows[index - 1]?.folderId);
        return true;
      case "ArrowDown":
        focusRow(rows[index + 1]?.folderId);
        return true;
      case "Home":
        focusRow(rows[0]?.folderId);
        return true;
      case "End":
        focusRow(rows.at(-1)?.folderId);
        return true;
      case "ArrowRight":
        if (hasChildren && !isOpen) toggle(node.folderId);
        else if (hasChildren) focusRow(node.children[0]?.folderId);
        return true;
      case "ArrowLeft":
        if (hasChildren && isOpen) toggle(node.folderId);
        else focusRow(node.parentId ?? undefined);
        return true;
      default:
        return false;
    }
  };

  const focusRow = (folderId: string | undefined) => {
    if (!folderId) return;
    list.current?.querySelector<HTMLElement>(`[data-folder-row="${folderId}"]`)?.focus();
  };

  const toggle = (folderId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: FOLDER_KEYS_HINT },
      }}
      onDragStart={({ active }) => setDragging(String(active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={(event) => void onDragEnd(event)}
    >
      <p id={hintId} className="sr-only">
        {FOLDER_KEYS_HINT}
      </p>
      <div ref={list} className="flex flex-col gap-0.5">
        {rows.map((node) => {
          const selected = selectedFolderId === node.folderId;
          const hasChildren = node.children.length > 0;
          const isInbox = node.system === "inbox";
          const label = node.locked ? (node.name ?? "ロック中のフォルダ") : node.name;

          return (
            <FolderRowDropZones
              key={node.folderId}
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
                      inbox={isInbox}
                      locked={node.locked}
                      open={hasChildren && expanded.has(node.folderId)}
                    />
                    <InlineRename
                      initialValue={node.name ?? ""}
                      label="フォルダ名"
                      className="h-6"
                      onSubmit={(value) => renameFolder(node.folderId, value)}
                      onDone={(byKeyboard) => {
                        if (byKeyboard) refocus.current = node.folderId;
                        setEditing(null);
                      }}
                    />
                  </div>
                ) : (
                  <FolderDragButton
                    folderId={node.folderId}
                    disabled={!canDrag || isInbox}
                    onClick={() => onSelect(node.folderId)}
                    // A locked folder's name is unreadable until the vault is
                    // open, and there is nothing to edit in a placeholder.
                    onKeyDown={(event) => onRowKeyDown(event, node, node.name !== null)}
                    describedBy={hintId}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left outline-none"
                  >
                    {/* Every row carries a folder glyph. Without one, plain folders
                    were bare names and read no differently from notes. */}
                    <FolderGlyph
                      inbox={isInbox}
                      locked={node.locked}
                      open={hasChildren && expanded.has(node.folderId)}
                    />
                    <span className="truncate">{label ?? "無題のフォルダ"}</span>
                  </FolderDragButton>
                )}

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
                    onCloseAutoFocus={(event) => {
                      if (!openingDialog.current) return;
                      openingDialog.current = false;
                      event.preventDefault();
                    }}
                  >
                    <DropdownMenuItem
                      onSelect={async () => {
                        const id = await createFolder({
                          parentId: node.folderId,
                          name: "新しいフォルダ",
                        });
                        setExpanded((c) => new Set(c).add(node.folderId));
                        onCreated(id);
                      }}
                    >
                      <FolderPlus className="size-4" aria-hidden />
                      サブフォルダを追加
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openDialog(() => setRenaming(node))}>
                      <Pencil className="size-4" aria-hidden />
                      名前を変更
                    </DropdownMenuItem>
                    {!isInbox ? (
                      <DropdownMenuItem onSelect={() => openDialog(() => setMoving(node))}>
                        <FolderInput className="size-4" aria-hidden />
                        別のフォルダへ移動
                      </DropdownMenuItem>
                    ) : null}
                    {onRequestLock ? (
                      <DropdownMenuItem onSelect={() => openDialog(() => onRequestLock(node))}>
                        <Lock className="size-4" aria-hidden />
                        {node.locked ? "ロックを解除" : "ロックする"}
                      </DropdownMenuItem>
                    ) : null}
                    {!isInbox ? (
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

        <RootDropZone active={dragging !== null} />

        <FolderPicker
          open={moving !== null}
          title="フォルダを移動"
          rootLabel="いちばん上の階層"
          // A folder cannot be dropped inside itself or its own children.
          excludeSubtreeOf={moving?.folderId}
          onOpenChange={(open) => !open && setMoving(null)}
          onPick={async (parentId) => {
            if (moving) await moveFolder(moving.folderId, parentId);
            setMoving(null);
            toast.success("移動しました");
          }}
        />

        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="rounded-md border bg-card px-2 py-1.5 text-sm shadow-lg">
              {findNode(tree, dragging)?.name ?? "フォルダ"}
            </div>
          ) : null}
        </DragOverlay>

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
    </DndContext>
  );
}

/** The icon at the start of a folder row: Inbox, locked, open or closed. */
function FolderGlyph({
  inbox,
  locked,
  open,
}: {
  inbox: boolean;
  locked: boolean;
  open: boolean;
}) {
  const Icon = inbox ? Inbox : locked ? FolderLock : open ? FolderOpen : FolderIcon;
  return <Icon className="size-4 shrink-0 opacity-70" aria-hidden />;
}
