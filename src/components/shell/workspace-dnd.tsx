"use client";

import {
  type Active,
  type Announcements,
  type Collision,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { HOLD_MS } from "@/lib/gesture/drawer-swipe";

/**
 * What is dragged, and what it is dropped on, as dnd-kit carries it: by
 * whose it is (`owner`, the folder tree or the note list it came from), so
 * that one list's drags are told apart from another's, and a sidebar's
 * folder tree from the drawer's.
 */
export type DragData =
  | { owner: string; kind: "folder"; folderId: string }
  | { owner: string; kind: "note"; noteId: string }
  /** A folder's row, to drop into it: a note, or another folder. */
  | { owner: string; kind: "into"; folderId: string }
  /** The strip above a folder's row, to put a folder (or a note) before it. */
  | { owner: string; kind: "before"; folderId: string }
  /** The strip above a note's row in the sidebar, to put a folder or a note before it. */
  | { owner: string; kind: "beforeNote"; noteId: string }
  /** The strip below the last note's row of a folder in the sidebar, to put a note after it. */
  | { owner: string; kind: "afterNote"; noteId: string }
  /** Where a folder, or a note, goes to the top level. */
  | { owner: string; kind: "root" };

/** What a drag's owner does with it: where it can go, and what a drop there does. */
export type DragHandlers = {
  collide: CollisionDetection;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragCancel?: () => void;
  /** What a screen reader is told as it goes, in Japanese (dnd-kit's are English). */
  announcements: Announcements;
  /** What follows the pointer while it is dragged. */
  overlay?: (active: Active) => ReactNode;
};

const Owners = createContext<Map<string, { current: DragHandlers }> | null>(null);

/** Whose drag this is, by what it carries. */
const ownerOf = (active: Active | null | undefined) =>
  (active?.data.current as DragData | undefined)?.owner;

/**
 * One place for every drag in the workspace, so that a note dragged from the
 * list can be dropped on a folder in the sidebar: each of them, folders and
 * notes, handled by the list or tree it came from (see useWorkspaceDrag).
 */
export function WorkspaceDnd({ children }: { children: ReactNode }) {
  const [owners] = useState(() => new Map<string, { current: DragHandlers }>());
  const [active, setActive] = useState<Active | null>(null);
  const handlersOf = (of: Active | null | undefined) => {
    const owner = ownerOf(of);
    return owner === undefined ? undefined : owners.get(owner)?.current;
  };

  // A finger held down first, so that one moving a list scrolls it, and held
  // past the time a swipe opens the folder drawer (drawer-swipe.ts), so that
  // the two never both start; a mouse moved a little way, so a click is a
  // click. Folders are dragged by a mouse only (their rows say so).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: HOLD_MS + 50, tolerance: 8 } }),
  );

  const announcements: Announcements = {
    onDragStart: (event) => handlersOf(event.active)?.announcements.onDragStart(event),
    onDragOver: (event) => handlersOf(event.active)?.announcements.onDragOver?.(event),
    onDragEnd: (event) => handlersOf(event.active)?.announcements.onDragEnd?.(event),
    onDragCancel: (event) => handlersOf(event.active)?.announcements.onDragCancel?.(event),
  };

  return (
    <Owners.Provider value={owners}>
      <DndContext
        sensors={sensors}
        collisionDetection={(args) => handlersOf(args.active)?.collide(args) ?? []}
        accessibility={{
          announcements,
          // Unused by the rows themselves (they keep their own roles and
          // descriptions), but said where dnd-kit says its own.
          screenReaderInstructions: { draggable: "ドラッグして移動します。" },
        }}
        onDragStart={(event) => {
          setActive(event.active);
          handlersOf(event.active)?.onDragStart?.(event);
        }}
        onDragEnd={(event) => {
          setActive(null);
          handlersOf(event.active)?.onDragEnd?.(event);
        }}
        onDragCancel={(event) => {
          setActive(null);
          handlersOf(event.active)?.onDragCancel?.();
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active ? (handlersOf(active)?.overlay?.(active) ?? null) : null}
        </DragOverlay>
      </DndContext>
    </Owners.Provider>
  );
}

/**
 * Handles the drags of what `owner` (a list's or tree's own id) carries: the
 * latest handlers each time, without registering again. Nothing outside the
 * workspace's drags.
 */
export function useWorkspaceDrag(owner: string, handlers: DragHandlers) {
  const owners = useContext(Owners);
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!owners) return;
    owners.set(owner, latest);
    return () => {
      if (owners.get(owner) === latest) owners.delete(owner);
    };
  }, [owners, owner]);
}

/**
 * Those of the targets under the pointer that are on the screen there: not
 * one scrolled out of its list's view, behind what is drawn over it (the
 * sidebar's header and links), which pointerWithin, going by boxes alone,
 * would take.
 */
export function shownUnderPointer(
  collisions: Collision[],
  { droppableContainers, pointerCoordinates }: Parameters<CollisionDetection>[0],
): Collision[] {
  if (!pointerCoordinates || collisions.length === 0) return collisions;
  const under = document.elementsFromPoint(pointerCoordinates.x, pointerCoordinates.y);
  return collisions.filter((collision) => {
    const node = droppableContainers.find((container) => container.id === collision.id)?.node
      .current;
    return node ? under.some((element) => node.contains(element)) : false;
  });
}

/** What a drag or drop target carries, typed. */
export const dragData = (of: { data: { current?: unknown } } | null | undefined) =>
  of?.data.current as DragData | undefined;
