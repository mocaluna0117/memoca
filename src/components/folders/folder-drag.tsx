"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Drop targets for a folder row.
 *
 * Two of them: a thin strip above the row places the dragged folder there as a
 * sibling, and the row itself moves it inside. Without the strip there is no
 * way to express "at the top level, above this one" with a drag.
 */
export function FolderRowDropZones({
  folderId,
  disabled,
  children,
}: {
  folderId: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef: setBeforeRef, isOver: overBefore } = useDroppable({
    id: `before:${folderId}`,
    disabled,
  });
  const { setNodeRef: setIntoRef, isOver: overInto } = useDroppable({
    id: `into:${folderId}`,
    disabled,
  });

  return (
    <div className="relative" ref={setIntoRef}>
      <div
        ref={setBeforeRef}
        className={cn(
          "absolute inset-x-0 -top-1 z-10 h-2",
          overBefore &&
            "before:bg-primary before:absolute before:inset-x-0 before:top-1 before:h-0.5 before:rounded-full",
        )}
        aria-hidden
      />
      <div
        className={cn(
          "rounded-md",
          overInto && !overBefore && "ring-primary/60 bg-accent/60 ring-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The folder's own button, which is also what you drag with a pointer.
 *
 * One element rather than a draggable wrapper around a button: wrapping gave
 * every folder two controls with the same name, so screen readers announced
 * each one twice and "which one do I press" had no good answer. The keys are
 * the tree's to decide, so they arrive through `onKeyDown`.
 */
export function FolderDragButton({
  folderId,
  disabled,
  onClick,
  onKeyDown,
  describedBy,
  className,
  children,
}: {
  folderId: string;
  disabled: boolean;
  onClick: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  describedBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const {
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: folderId, disabled });

  return (
    <button
      ref={setDragRef}
      type="button"
      data-folder-row={folderId}
      // None of dnd-kit's attributes: the native button already has the right
      // role and focus behaviour, and its aria-pressed would announce an
      // ordinary button as a toggle.
      aria-describedby={describedBy}
      className={cn(className, isDragging && "opacity-40")}
      {...listeners}
      onClick={(event) => {
        // Safari does not focus a button it clicks, and the keys below act on
        // the focused row, so a click has to put focus there itself.
        event.currentTarget.focus();
        onClick();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) listeners?.onKeyDown?.(event);
      }}
    >
      {children}
    </button>
  );
}

/** Drop target for moving a folder back out to the top level. */
export function RootDropZone({ active }: { active: boolean }) {
  const { setNodeRef: setRootRef, isOver } = useDroppable({ id: "root" });
  if (!active) return null;
  return (
    <div
      ref={setRootRef}
      className={cn(
        "text-muted-foreground mt-1 rounded-md border border-dashed px-2 py-2 text-center text-xs",
        isOver && "border-primary text-foreground bg-accent/60",
      )}
    >
      いちばん上の階層へ移動
    </div>
  );
}
