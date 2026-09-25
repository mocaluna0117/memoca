"use client";

import { FolderIcon, Inbox, Lock } from "lucide-react";
import { useMemo } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFolderTree } from "@/lib/hooks/data";
import { flattenTree } from "@/lib/tree";
import type { FolderNode } from "@/lib/types";
import { t } from "@/lib/i18n/ja";

/**
 * Picks a destination folder.
 *
 * The whole tree is flattened and searchable, because on a phone drilling
 * through nested folders to move one note is far more work than typing part of
 * its name.
 */
export function FolderPicker({
  open,
  onOpenChange,
  onPick,
  /** Hidden from the list, along with everything inside it. */
  excludeSubtreeOf,
  /**
   * Offers "no parent" as a destination, under this label. Right for moving a
   * folder to the top level; left unset for notes, because a note with no
   * folder belongs in Inbox, which is already in the list.
   */
  rootLabel,
  title = t.action.move,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (folderId: string | null) => void;
  excludeSubtreeOf?: string;
  rootLabel?: string;
  title?: string;
}) {
  const tree = useFolderTree();

  const rows = useMemo(() => {
    const all = new Set<string>();
    flattenTree(tree, new Set(tree.map((f) => f.folderId))).forEach((node) =>
      all.add(node.folderId),
    );
    const expanded = new Set(all);
    const flat = flattenTree(tree, expanded);
    if (!excludeSubtreeOf) return flat;

    const blocked = new Set<string>();
    const mark = (node: FolderNode) => {
      blocked.add(node.folderId);
      node.children.forEach(mark);
    };
    const find = (nodes: FolderNode[]): FolderNode | null => {
      for (const node of nodes) {
        if (node.folderId === excludeSubtreeOf) return node;
        const inner = find(node.children);
        if (inner) return inner;
      }
      return null;
    };
    const root = find(tree);
    if (root) mark(root);
    return flat.filter((node) => !blocked.has(node.folderId));
  }, [tree, excludeSubtreeOf]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>移動先のフォルダを選んでください。</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="フォルダ名で絞り込む" />
          <CommandList className="max-h-72">
            <CommandEmpty>{t.empty.noResults}</CommandEmpty>
            <CommandGroup>
              {rootLabel ? (
                <CommandItem
                  value={`__root__ ${rootLabel}`}
                  onSelect={() => {
                    onPick(null);
                    onOpenChange(false);
                  }}
                >
                  <FolderIcon className="size-4 opacity-70" aria-hidden />
                  {rootLabel}
                </CommandItem>
              ) : null}
              {rows.map((node) => (
                <CommandItem
                  key={node.folderId}
                  value={`${node.folderId} ${node.name ?? ""}`}
                  onSelect={() => {
                    onPick(node.folderId);
                    onOpenChange(false);
                  }}
                >
                  <span style={{ width: node.depth * 12 }} aria-hidden />
                  {node.system === "inbox" ? (
                    <Inbox className="size-4 opacity-70" aria-hidden />
                  ) : node.locked ? (
                    <Lock className="size-4 opacity-70" aria-hidden />
                  ) : (
                    <FolderIcon className="size-4 opacity-70" aria-hidden />
                  )}
                  {node.name ?? "ロックされたフォルダ"}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
