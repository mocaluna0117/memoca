import { createExtension } from "@blocknote/core";
import { Plugin } from "prosemirror-state";

/**
 * Keeps a line whose only text is a word being committed from the input
 * method from being taken out whole.
 *
 * On committing, WebKit (the Mac desktop app's, at least) first deletes the
 * word being composed, then inserts the word chosen. Deleting it leaves the
 * line with nothing in it, and when the line is the only one in its group,
 * as an item indented under another is, WebKit takes the line's elements out
 * altogether, leaving a bare line break in the group. ProseMirror reads that
 * as a new, empty line: the word stays in the line it was in, the caret
 * moves to the new one, and the word chosen goes there too, so it came out
 * twice. (ProseMirror undoes Safari's same doing in ul and ol, which
 * BlockNote's lists are not.)
 *
 * An element of ProseMirror's own kind put at the end of the line first,
 * the zero-width image it draws beside a widget in Safari, keeps WebKit from
 * counting the line as empty, so only the word goes. ProseMirror leaves it
 * out when it reads the line (mark-placeholder), and it is taken away once
 * the word is in.
 */
export function keepLineThroughCommit(selection: Selection | null): HTMLElement | null {
  const anchor = selection?.anchorNode ?? null;
  const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  const line = element?.closest(".bn-inline-content");
  if (!line) return null;
  const keeper = document.createElement("img");
  keeper.className = "ProseMirror-separator";
  keeper.setAttribute("mark-placeholder", "true");
  keeper.alt = "";
  line.appendChild(keeper);
  return keeper;
}

export const imeCommit = createExtension({
  key: "memocaImeCommit",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleDOMEvents: {
          beforeinput: (_view, event) => {
            // WebKit's only: Chrome takes no change to the line while composing well.
            if (event.inputType !== "deleteCompositionText" || !/Apple/.test(navigator.vendor)) {
              return false;
            }
            const keeper = keepLineThroughCommit(document.getSelection());
            if (keeper) {
              const done = () => setTimeout(() => keeper.remove());
              document.addEventListener("compositionend", done, { once: true });
            }
            return false;
          },
        },
      },
    }),
  ],
});
