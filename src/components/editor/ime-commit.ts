import { createExtension } from "@blocknote/core";

/** A line as far as this needs it. */
type Line = { id: string; content?: unknown; children: unknown[] };

/**
 * What a commit of a word from the input method should have left, if it
 * left the caret in a new line next to the one the word was written in:
 * the word in the line it was written in, and no new line. Null when
 * nothing needs putting right.
 *
 * In the Mac desktop app's WebKit, committing a word first deletes the word
 * being composed. A line alone in its group, as an item indented under
 * another is, is then left empty, and WebKit takes it out of the page
 * altogether. ProseMirror finds the group empty and, a group needing a line,
 * makes a new one there; the caret goes to it, and the word chosen with it.
 * The line the word was written in stays, with the word or empty. (Safari
 * does not delete the word first, so the web app never did this.)
 */
export function strayLine(
  started: string | null,
  now: Line | undefined,
  before: Line | undefined,
): { keep: string; drop: string } | null {
  if (!started || !now || now.id === started) return null;
  // Only the new line right after it, with nothing under it.
  if (!before || before.id !== started || now.children.length > 0) return null;
  return { keep: started, drop: now.id };
}

export const imeCommit = createExtension(({ editor }) => ({
  key: "memocaImeCommit",
  mount({ dom, signal }) {
    // WebKit's only: elsewhere a word is committed in its own line.
    if (!/Apple/.test(navigator.vendor)) return;
    let started: string | null = null;
    dom.addEventListener(
      "compositionstart",
      () => {
        started = editor.getTextCursorPosition().block.id;
      },
      { signal },
    );
    dom.addEventListener(
      "compositionend",
      () => {
        const from = started;
        started = null;
        // Once ProseMirror has taken in the commit and finished composing.
        setTimeout(() => {
          const view = editor.prosemirrorView;
          if (!view || view.composing) return;
          const now = editor.getTextCursorPosition().block as Line;
          const fix = strayLine(from, now, editor.getPrevBlock(now.id) as Line | undefined);
          if (!fix) return;
          editor.transact(() => {
            editor.updateBlock(fix.keep, { content: now.content } as never);
            editor.removeBlocks([fix.drop]);
            editor.setTextCursorPosition(fix.keep, "end");
          });
        });
      },
      { signal },
    );
  },
}));
