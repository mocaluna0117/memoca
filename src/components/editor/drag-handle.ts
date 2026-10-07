import { createExtension } from "@blocknote/core";

/** A block's handle, in its side menu: dragged to move it, clicked for its menu. */
const HANDLE = '.bn-side-menu [draggable="true"]';

/**
 * A block's handle opens its menu when clicked, not as soon as it is
 * pressed, so it can be dragged. The menu (Base UI's, in BlockNote's shadcn
 * look) opens on the press, and while it is open marks all else inert: the
 * block dragged then has nowhere to be dropped, and stays where it was.
 *
 * The press is kept from the menu (on its way down, before React has it),
 * not stopped: the browser still starts a drag from it. Unpressed, the menu
 * takes the click that follows as a keyboard's, and opens on it.
 */
export const dragHandle = createExtension({
  key: "memocaDragHandle",
  mount({ root, signal }) {
    const keep = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(HANDLE)) {
        event.stopPropagation();
      }
    };
    for (const type of ["pointerdown", "mousedown"]) {
      root.addEventListener(type, keep, { capture: true, signal });
    }

    // While a block is dragged, BlockNote has it selected, so its formatting
    // toolbar shows, over the line above: as wide as it is (文字の大きさ
    // made it so), it covers that line's right edge, and a block dropped
    // there, to go beside it in a column, landed on the toolbar instead.
    // Hidden for the drag (globals.css), it lets the drop through.
    const marked = document.documentElement.dataset;
    const start = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(HANDLE)) {
        marked.blockDragging = "";
      }
    };
    const end = () => delete marked.blockDragging;
    root.addEventListener("dragstart", start, { capture: true, signal });
    for (const type of ["dragend", "drop"]) {
      document.addEventListener(type, end, { capture: true, signal });
    }
    signal.addEventListener("abort", end);
  },
});
