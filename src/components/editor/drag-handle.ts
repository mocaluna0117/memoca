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
  },
});
