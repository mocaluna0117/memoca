"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
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
import { useState } from "react";
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

  // Dragging a row inside a scrolling drawer fights the scroll on a phone, and
  // the move dialog covers the same need there, so this is a pointer feature.
  const canDrag = useMediaQuery("(pointer: fine)");

  const sensors = useSensors(
    // A small threshold so a plain click still selects the folder.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Space picks a folder up; Enter is left to the button, so it still opens.
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
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
        screenReaderInstructions: {
          draggable:
            "スペースキーでフォルダをつかみ、矢印キーで移動先を選び、もう一度スペースキーで移動します。Esc で取り消します。",
        },
      }}
      onDragStart={({ active }) => setDragging(String(active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={(event) => void onDragEnd(event)}
    >
      <div className="flex flex-col gap-0.5">
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

                <FolderDragButton
                  folderId={node.folderId}
                  disabled={!canDrag || isInbox}
                  onClick={() => onSelect(node.folderId)}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
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
                  <DropdownMenuContent align="end" className="w-44" portalContainer={menuContainer}>
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
                    <DropdownMenuItem onSelect={() => setRenaming(node)}>
                      <Pencil className="size-4" aria-hidden />
                      名前を変更
                    </DropdownMenuItem>
                    {!isInbox ? (
                      <DropdownMenuItem onSelect={() => setMoving(node)}>
                        <FolderInput className="size-4" aria-hidden />
                        別のフォルダへ移動
                      </DropdownMenuItem>
                    ) : null}
                    {onRequestLock ? (
                      <DropdownMenuItem onSelect={() => onRequestLock(node)}>
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
