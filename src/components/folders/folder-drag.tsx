"use client";

import { useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import type { KeyboardEvent, ReactNode } from "react";
import type { DragData } from "@/components/shell/workspace-dnd";
import { cn } from "@/lib/utils";

/**
 * Drop targets for a folder row.
 *
 * Two of them: a thin strip above the row places the dragged folder there as a
 * sibling, and the row itself moves it inside. Without the strip there is no
 * way to express "at the top level, above this one" with a drag. A note
 * dragged from the list goes into the row, the strip being for folders.
 * By the tree they are in (`owner`), as there can be two (the sidebar's, and
 * the drawer's on a phone).
 */
export function FolderRowDropZones({
  owner,
  folderId,
  disabled,
  children,
}: {
  owner: string;
  folderId: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef: setBeforeRef, isOver: overBefore } = useDroppable({
    id: `${owner}/before/${folderId}`,
    data: { owner, kind: "before", folderId } satisfies DragData,
    disabled,
  });
  const { setNodeRef: setIntoRef, isOver: overInto } = useDroppable({
    id: `${owner}/into/${folderId}`,
    data: { owner, kind: "into", folderId } satisfies DragData,
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
  owner,
  folderId,
  disabled,
  onClick,
  onKeyDown,
  describedBy,
  className,
  children,
}: {
  owner: string;
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
  } = useDraggable({
    id: `${owner}/folder/${folderId}`,
    data: { owner, kind: "folder", folderId } satisfies DragData,
    disabled,
  });

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

/**
 * Drop target for moving a folder back out to the top level, or a note to
 * it (into the sidebar, in no folder): shown while anything is dragged, a
 * note from the list included.
 */
export function RootDropZone({ owner }: { owner: string }) {
  const { active } = useDndContext();
  const { setNodeRef: setRootRef, isOver } = useDroppable({
    id: `${owner}/root`,
    data: { owner, kind: "root" } satisfies DragData,
  });
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

/**
 * A note's row in the sidebar (one at the top level, in no folder): the
 * strip above it, to put what is dragged before it, round the row.
 */
export function NoteRowDropZone({
  owner,
  noteId,
  disabled,
  children,
}: {
  owner: string;
  noteId: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${owner}/beforeNote/${noteId}`,
    data: { owner, kind: "beforeNote", noteId } satisfies DragData,
    disabled,
  });
  return (
    <div className="relative">
      <div
        ref={setNodeRef}
        className={cn(
          "absolute inset-x-0 -top-1 z-10 h-2",
          isOver &&
            "before:bg-primary before:absolute before:inset-x-0 before:top-1 before:h-0.5 before:rounded-full",
        )}
        aria-hidden
      />
      {children}
    </div>
  );
}

/** A note's own button in the sidebar, which is also what you drag it by (see FolderDragButton). */
export function NoteDragButton({
  owner,
  noteId,
  disabled,
  onClick,
  onKeyDown,
  describedBy,
  className,
  children,
}: {
  owner: string;
  noteId: string;
  disabled: boolean;
  /** With the keys held, which choose notes rather than open one. */
  onClick: (held: { meta: boolean; ctrl: boolean; shift: boolean }) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  describedBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: `${owner}/note/${noteId}`,
    data: { owner, kind: "note", noteId } satisfies DragData,
    disabled,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-tree-note={noteId}
      aria-describedby={describedBy}
      className={cn(className, isDragging && "opacity-40")}
      {...listeners}
      onClick={(event) => {
        event.currentTarget.focus();
        onClick({ meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey });
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
