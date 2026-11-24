"use client";

import {
  type Active,
  type Announcements,
  type Collision,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  type MouseSensorOptions,
  type SensorProps,
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

/**
 * dnd-kit's mouse sensor, made to let go when the button has been let go of
 * unheard. It ends a drag, or the press that would start one, only on a
 * mouseup; one the page never hears leaves it held, and the row then follows
 * the pointer, the button up, until the next click drops it. Memoca for Mac
 * did that now and then, most likely on the click that brought its window
 * to the front from another app or window. A move with no button down, or
 * the window losing focus, now ends it as Escape does: dropped nowhere.
 */
class ReleasingMouseSensor extends MouseSensor {
  constructor(props: SensorProps<MouseSensorOptions>) {
    const done = new AbortController();
    const ended = <T extends unknown[]>(handler: (...args: T) => void) =>
      (...args: T) => {
        done.abort();
        handler(...args);
      };
    super({
      ...props,
      onAbort: ended(props.onAbort),
      onCancel: ended(props.onCancel),
      onEnd: ended(props.onEnd),
    });
    if (done.signal.aborted) return;
    // dnd-kit's own way out, kept to itself.
    const cancel = () => (this as unknown as { handleCancel(): void }).handleCancel();
    const target = props.event.target instanceof Node ? props.event.target : null;
    const document = target?.ownerDocument ?? window.document;
    const view = document.defaultView ?? window;
    document.addEventListener(
      "mousemove",
      (event) => {
        if (event.buttons === 0) cancel();
      },
      { capture: true, signal: done.signal },
    );
    view.addEventListener("blur", cancel, { signal: done.signal });
  }
}

/**
 * How far a mouse goes with its button down before a row is dragged, in CSS
 * pixels: less, and it is a click. Raised from 6: on a Mac trackpad a pressed
 * click rolls that far, and the folder or note then did not open (the drag,
 * dropped where it began, was no click), and had to be clicked again.
 */
export const MOUSE_DRAG_PX = 10;
/**
 * A drag by a mouse that never went further than this from where it began
 * was a click that moved, not a move: taken back, and clicked. Less than half
 * a row, so no drag that would have moved something by a place is lost; a
 * real drag goes much further, and the move dialogs are there too.
 */
export const CLICK_SLOP_PX = 16;

/** Whether a drag that has ended was a click that moved a little (see CLICK_SLOP_PX). */
export function clickAfterAll(event: Pick<DragEndEvent, "activatorEvent">, farthest: number): boolean {
  const pressed = event.activatorEvent;
  // A finger's hold is a gesture of its own (a note's menu, say).
  if (!pressed || "touches" in pressed || pressed.type.startsWith("touch")) return false;
  return farthest < CLICK_SLOP_PX;
}

/**
 * Clicks what the mouse was pressed on. Once dnd-kit is done with it: it
 * swallows clicks for 50 ms after a drag (the browser's own one among them).
 */
function clickWhatWasPressed(pressed: Event | null) {
  const target = pressed?.target;
  const button =
    target instanceof Element ? target.closest<HTMLElement>("button, a[href], [role='button']") : null;
  if (!button) return;
  setTimeout(() => {
    if (button.isConnected) button.click();
  }, 80);
}

/**
 * How a drag starts: a finger held down first, so that one moving a list
 * scrolls it, and held past the time a swipe opens the folder drawer
 * (drawer-swipe.ts), so that the two never both start; a mouse moved a
 * little way, so a click is a click (see MOUSE_DRAG_PX). Folders are dragged
 * by a mouse only (their rows say so).
 *
 * Made once, here: given anew with each draw of the workspace, they made
 * dnd-kit's sensors anew, and with them the context every row that can be
 * dragged or dropped on reads, and every row of the note list (300 of them,
 * with their tooltips and menus) was drawn again each time a note opened.
 */
const MOUSE_OPTIONS = { activationConstraint: { distance: MOUSE_DRAG_PX } };
const TOUCH_OPTIONS = { activationConstraint: { delay: HOLD_MS + 50, tolerance: 8 } };

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
  /** How far the drag under way has gone from where it started, at the most. */
  const farthest = useRef(0);
  const handlersOf = (of: Active | null | undefined) => {
    const owner = ownerOf(of);
    return owner === undefined ? undefined : owners.get(owner)?.current;
  };

  // The same options each time (see MOUSE_OPTIONS): new ones were new sensors.
  const sensors = useSensors(
    useSensor(ReleasingMouseSensor, MOUSE_OPTIONS),
    useSensor(TouchSensor, TOUCH_OPTIONS),
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
          farthest.current = 0;
          setActive(event.active);
          handlersOf(event.active)?.onDragStart?.(event);
        }}
        onDragMove={(event: DragMoveEvent) => {
          farthest.current = Math.max(farthest.current, Math.hypot(event.delta.x, event.delta.y));
        }}
        onDragEnd={(event) => {
          setActive(null);
          const handlers = handlersOf(event.active);
          if (clickAfterAll(event, farthest.current)) {
            handlers?.onDragCancel?.();
            clickWhatWasPressed(event.activatorEvent);
            return;
          }
          handlers?.onDragEnd?.(event);
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
