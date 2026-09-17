"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";
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

export function FolderDragHandle({
  folderId,
  disabled,
  children,
}: {
  folderId: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: folderId, disabled });

  return (
    <div
      ref={setDragRef}
      className={cn("flex min-w-0 flex-1", isDragging && "opacity-40")}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
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
