"use client";

import { useBlockNoteEditor, useSelectedBlocks } from "@blocknote/react";
import {
  ChevronDown,
  ChevronUp,
  Code,
  Heading1,
  Heading2,
  Indent,
  List,
  ListChecks,
  ListOrdered,
  Outdent,
  Quote,
  Trash2,
  Type,
} from "lucide-react";
import { useKeyboardInset } from "@/lib/hooks/use-keyboard-inset";
import { cn } from "@/lib/utils";

type BlockType =
  | "paragraph"
  | "heading"
  | "bulletListItem"
  | "numberedListItem"
  | "checkListItem"
  | "quote"
  | "codeBlock";

/**
 * Block controls for touch screens.
 *
 * The editor's own drag handle appears on hover, which a finger never
 * produces, so on a phone there is otherwise no way to change a block's type,
 * move it or delete it. This bar sits above the keyboard and acts on whichever
 * block the cursor is in.
 */
export function MobileBlockToolbar() {
  const editor = useBlockNoteEditor();
  const selected = useSelectedBlocks(editor);
  const inset = useKeyboardInset();

  const block = selected.at(0);
  if (!block || inset === 0) return null;

  const currentType = block.type as BlockType;
  const currentLevel = (block.props as { level?: number } | undefined)?.level;

  const setType = (type: BlockType, level?: 1 | 2) => {
    const same = currentType === type && (level === undefined || currentLevel === level);
    editor.updateBlock(block, {
      type: same ? "paragraph" : type,
      ...(level !== undefined && !same ? { props: { level } } : {}),
    } as Parameters<typeof editor.updateBlock>[1]);
    editor.focus();
  };

  const actions: {
    key: string;
    label: string;
    icon: typeof Type;
    active?: boolean;
    disabled?: boolean;
    run: () => void;
  }[] = [
    {
      key: "h1",
      label: "大見出し",
      icon: Heading1,
      active: currentType === "heading" && currentLevel === 1,
      run: () => setType("heading", 1),
    },
    {
      key: "h2",
      label: "小見出し",
      icon: Heading2,
      active: currentType === "heading" && currentLevel === 2,
      run: () => setType("heading", 2),
    },
    {
      key: "bullet",
      label: "箇条書き",
      icon: List,
      active: currentType === "bulletListItem",
      run: () => setType("bulletListItem"),
    },
    {
      key: "numbered",
      label: "番号付き",
      icon: ListOrdered,
      active: currentType === "numberedListItem",
      run: () => setType("numberedListItem"),
    },
    {
      key: "check",
      label: "チェック",
      icon: ListChecks,
      active: currentType === "checkListItem",
      run: () => setType("checkListItem"),
    },
    {
      key: "quote",
      label: "引用",
      icon: Quote,
      active: currentType === "quote",
      run: () => setType("quote"),
    },
    {
      key: "code",
      label: "コード",
      icon: Code,
      active: currentType === "codeBlock",
      run: () => setType("codeBlock"),
    },
    {
      key: "nest",
      label: "字下げ",
      icon: Indent,
      disabled: !editor.canNestBlock(),
      run: () => {
        editor.nestBlock();
        editor.focus();
      },
    },
    {
      key: "unnest",
      label: "字下げを戻す",
      icon: Outdent,
      disabled: !editor.canUnnestBlock(),
      run: () => {
        editor.unnestBlock();
        editor.focus();
      },
    },
    {
      key: "up",
      label: "上へ移動",
      icon: ChevronUp,
      run: () => {
        editor.moveBlocksUp();
        editor.focus();
      },
    },
    {
      key: "down",
      label: "下へ移動",
      icon: ChevronDown,
      run: () => {
        editor.moveBlocksDown();
        editor.focus();
      },
    },
    {
      key: "plain",
      label: "本文に戻す",
      icon: Type,
      active: currentType === "paragraph",
      run: () => setType("paragraph"),
    },
    {
      key: "delete",
      label: "ブロックを削除",
      icon: Trash2,
      run: () => {
        editor.removeBlocks([block]);
        editor.focus();
      },
    },
  ];

  return (
    <div
      className="bg-background/95 supports-[backdrop-filter]:bg-background/80 fixed inset-x-0 z-40 border-t backdrop-blur md:hidden"
      style={{ bottom: inset }}
      role="toolbar"
      aria-label="ブロックの操作"
    >
      <div className="flex gap-1 overflow-x-auto px-2 py-1.5">
        {actions.map(({ key, label, icon: Icon, active, disabled, run }) => (
          <button
            key={key}
            type="button"
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            // The editor must keep the caret, so the press never takes focus.
            onMouseDown={(event) => event.preventDefault()}
            onTouchStart={(event) => event.preventDefault()}
            onClick={run}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
              disabled && "opacity-30",
              key === "delete" && "text-destructive",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
