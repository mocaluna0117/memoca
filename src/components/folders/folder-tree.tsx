"use client";

import {
  ChevronRight,
  FolderInput,
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
import { flattenTree } from "@/lib/tree";
import {
  createFolder,
  moveFolder,
  renameFolder,
  setFolderTrashed,
} from "@/lib/sync/mutations";
import type { FolderNode } from "@/lib/types";
import { cn } from "@/lib/utils";
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
    <div className="flex flex-col gap-0.5">
      {rows.map((node) => {
        const selected = selectedFolderId === node.folderId;
        const hasChildren = node.children.length > 0;
        const isInbox = node.system === "inbox";
        const label = node.locked ? (node.name ?? "ロック中のフォルダ") : node.name;

        return (
          <div
            key={node.folderId}
            className={cn(
              "group flex items-center gap-1 rounded-md pr-1 text-sm",
              selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
            )}
            style={{ paddingLeft: `${node.depth * 12}px` }}
          >
            <button
              type="button"
              aria-label={hasChildren ? "開閉" : undefined}
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

            <button
              type="button"
              onClick={() => onSelect(node.folderId)}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            >
              {isInbox ? (
                <Inbox className="size-4 shrink-0 opacity-70" aria-hidden />
              ) : node.locked ? (
                <Lock className="size-4 shrink-0 opacity-70" aria-hidden />
              ) : null}
              <span className="truncate">{label ?? "無題のフォルダ"}</span>
            </button>

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
        );
      })}

      <FolderPicker
        open={moving !== null}
        title="フォルダを移動"
        // A folder cannot be dropped inside itself or its own children.
        excludeSubtreeOf={moving?.folderId}
        onOpenChange={(open) => !open && setMoving(null)}
        onPick={async (parentId) => {
          if (moving) await moveFolder(moving.folderId, parentId);
          setMoving(null);
          toast.success("移動しました");
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
  );
}
