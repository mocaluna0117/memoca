import { createExtension } from "@blocknote/core";
import { Plugin } from "prosemirror-state";
import { isApple } from "@/lib/platform";
import { inShell } from "@/lib/quick/shell";

/** How long after a composition ends a new line the browser makes counts as its Enter's. */
const AFTER_COMPOSITION_MS = 100;

/**
 * Whether a line the browser is about to make itself is the Enter that
 * committed a word in the input method: while the word is still being
 * composed, or straight after.
 *
 * In the Mac desktop app (a WKWebView), that Enter does not stay with the
 * input method as it does in Safari: WebKit also splits the line, while the
 * word is still marked, and the input method then commits the word again on
 * the new line. A word typed in an indented list item came out twice, on two
 * lines. ProseMirror takes no Enter while composing, so a line made then is
 * never one asked for.
 */
export function isCompositionEnter(
  event: Pick<InputEvent, "inputType" | "isComposing">,
  composing: boolean,
  sinceCompositionEnd: number,
): boolean {
  if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return false;
  return event.isComposing || composing || sinceCompositionEnd < AFTER_COMPOSITION_MS;
}

/** Keeps the Enter that commits a word from also making a line, in the Mac desktop app. */
export const imeEnter = createExtension({
  key: "memocaImeEnter",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleDOMEvents: (() => {
          let endedAt = -Infinity;
          const here = () =>
            typeof navigator !== "undefined" && inShell() && isApple(navigator.userAgent);
          return {
            compositionend: () => {
              endedAt = Date.now();
              return false;
            },
            beforeinput: (view, event) => {
              if (!here()) return false;
              if (!isCompositionEnter(event, view.composing, Date.now() - endedAt)) return false;
              event.preventDefault();
              return true;
            },
          };
        })(),
      },
    }),
  ],
});
