import { createExtension } from "@blocknote/core";
import { Plugin } from "prosemirror-state";

/** Room kept between the caret and the edge of what can be seen. */
const MARGIN = 8;
/** Less of the window covered than this is no keyboard (a browser's bar, say). */
const KEYBOARD_MIN = 40;

/**
 * How far the page is to scroll for a caret at `caret` (top and bottom on
 * the screen) to be seen, with the on-screen keyboard covering the window
 * from `visible.bottom` down (and anything over the top, to `visible.top`):
 * 0 when it is in sight.
 */
export function caretShift(
  caret: { top: number; bottom: number },
  visible: { top: number; bottom: number },
): number {
  if (caret.bottom > visible.bottom - MARGIN) return caret.bottom - (visible.bottom - MARGIN);
  if (caret.top < visible.top + MARGIN) return caret.top - (visible.top + MARGIN);
  return 0;
}

/**
 * Keeps the caret above the on-screen keyboard as a long note is typed in
 * on a phone. The browser scrolls the caret into the window as it is laid
 * out, which the keyboard does not shrink (iOS, and Chrome with the page
 * fit to the layout viewport): a line typed near the bottom could go on
 * under the keyboard. The visual viewport says what is really seen, and
 * the page is scrolled by what the caret is past it by, after each change.
 */
export const caretAboveKeyboard = createExtension({
  key: "memocaCaretAboveKeyboard",
  prosemirrorPlugins: [
    new Plugin({
      view: () => {
        let frame = 0;
        return {
          update(view, before) {
            if (!view.state.selection.empty || view.state.doc.eq(before.doc)) return;
            const viewport = window.visualViewport;
            if (!viewport) return;
            const covered = window.innerHeight - viewport.height - viewport.offsetTop;
            if (covered < KEYBOARD_MIN) return;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              frame = 0;
              if (!view.hasFocus()) return;
              let caret: { top: number; bottom: number };
              try {
                caret = view.coordsAtPos(view.state.selection.head);
              } catch {
                return;
              }
              // Above the block bar too, which sits on the keyboard.
              const bar = document.querySelector("[data-keyboard-bar]")?.getBoundingClientRect();
              const by = caretShift(caret, {
                top: viewport.offsetTop,
                bottom: viewport.offsetTop + viewport.height - (bar?.height ?? 0),
              });
              if (by !== 0) window.scrollBy(0, by);
            });
          },
          destroy() {
            cancelAnimationFrame(frame);
          },
        };
      },
    }),
  ],
});
