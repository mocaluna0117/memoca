import { createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * A line above a block with no text of its own (an image, a file, a
 * table), where there was no way to put one: the first block of a note,
 * with nothing above it to put the caret in. BlockNote adds a line only
 * below a block.
 *
 * - typing, or Enter, with the caret just before such a block: ProseMirror's
 *   gap cursor, a short line above it, where ↑ puts it from the block
 *   selected (an image clicked), and ← too. Moving there changes nothing;
 *   only what is typed there does;
 * - a click (not a drag) in the margin above the note's first block
 *   (BlockNote's frame, around the editor, as well as the editor's own);
 * - Enter in the note's title, which goes down to the note's first line,
 *   making one above if there is none (see title-enter.ts);
 * - on a phone, 上に行を追加 in the bar above the keyboard, for an image or
 *   a file selected (mobile-block-toolbar.tsx).
 */

/** The note's first block, where it is in the document: inside the note's group. */
const FIRST = 1;

/** Whether a block (a blockContainer) has no line of text to put the caret in. */
const hasNoLine = (container: Node | null | undefined) =>
  !!container && container.type.name === "blockContainer" && !container.firstChild?.isTextblock;

/** An empty line put before the block at `pos`, and the caret in it. */
export function lineAbove(state: EditorState, pos: number): Transaction {
  const { nodes } = state.schema;
  const line = nodes.blockContainer!.create(null, nodes.paragraph!.create());
  const tr = state.tr.insert(pos, line);
  return tr.setSelection(TextSelection.create(tr.doc, pos + 2)).scrollIntoView();
}

/** Whether the selection is ProseMirror's gap cursor: a caret between blocks, not in text. */
const isGapCursor = (state: EditorState) => state.selection.toJSON().type === "gapcursor";

/**
 * The block a selection is just before: the one selected whole (an image
 * clicked), or the one the gap cursor is at the start of. Its position, or
 * null.
 */
export function blockAtSelection(state: EditorState): number | null {
  const { selection, doc } = state;
  if (selection instanceof NodeSelection) {
    if (selection.node.type.name === "blockContainer") return selection.from;
    const $pos = doc.resolve(selection.from);
    return $pos.parent.type.name === "blockContainer" ? $pos.before() : null;
  }
  if (!isGapCursor(state)) return null;
  const $pos = selection.$from;
  if ($pos.parent.type.name === "blockContainer" && $pos.parentOffset === 0) return $pos.before();
  return $pos.nodeAfter?.type.name === "blockContainer" ? $pos.pos : null;
}

/**
 * Enter, or `text` typed, with the gap cursor before a block with no line
 * of text: a line above it, with the text in it.
 */
export function enterAtGap(state: EditorState, text = ""): Transaction | null {
  if (!isGapCursor(state)) return null;
  const pos = blockAtSelection(state);
  if (pos === null || !hasNoLine(state.doc.nodeAt(pos))) return null;
  const tr = lineAbove(state, pos);
  return text ? tr.insertText(text) : tr;
}

/**
 * Down from the note's title: the caret at the start of its first line,
 * or, where the note starts with an image (or a file, or a table), in a
 * new line above it.
 */
export function fromTitle(state: EditorState): Transaction {
  if (hasNoLine(state.doc.nodeAt(FIRST))) return lineAbove(state, FIRST);
  return state.tr.setSelection(TextSelection.near(state.doc.resolve(FIRST + 2))).scrollIntoView();
}

/** The note's first block on the screen, or null. */
const firstBlockOnScreen = (view: EditorView) => {
  const dom = view.nodeDOM(FIRST);
  return dom instanceof HTMLElement ? dom : null;
};

export const linesAbove = createExtension(({ editor }) => {
  const run = (make: (state: EditorState) => Transaction | null) => {
    const view = editor.prosemirrorView;
    if (!view?.editable) return false;
    const tr = make(view.state);
    if (!tr) return false;
    view.dispatch(tr);
    return true;
  };
  return {
    key: "memocaLinesAbove",
    keyboardShortcuts: {
      Enter: () => run(enterAtGap),
    },
    prosemirrorPlugins: [
      new Plugin({
        props: {
          handleDOMEvents: {
            // A letter typed at the gap cursor: the line made for it, with the
            // letter in it. ProseMirror's own gap cursor takes only a word
            // written with the input method (and makes its line well); a
            // letter it leaves to the editor, which puts it inside the
            // image's block, where it breaks the note.
            beforeinput: (_view, event) => {
              if (event.inputType !== "insertText" || !event.data) return false;
              const text = event.data;
              if (!run((state) => enterAtGap(state, text))) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ],
    mount({ dom, signal }) {
      // A click in the margin above the note's first block, when that block
      // has no line to put the caret in: the editor's own padding, and its
      // frame's around it (BlockNote's view), which is not the editor's. A
      // click, not a press: a drag begun there selects as it did.
      const frame = dom.closest(".bn-container") ?? dom;
      let pressed: { x: number; y: number } | null = null;
      frame.addEventListener(
        "mousedown",
        (event) => {
          pressed = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : null;
        },
        { signal },
      );
      frame.addEventListener(
        "click",
        (event) => {
          const view = editor.prosemirrorView;
          const target = event.target instanceof Element ? event.target : null;
          if (!view?.editable || !(event instanceof MouseEvent) || event.button !== 0) return;
          if (!pressed || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4) {
            return;
          }
          // The margin only: the frame itself, or the editor's own padding.
          // Not a block, nor what BlockNote draws over the frame (an image's
          // toolbar sits over the margin above it, its buttons not ours).
          if (!target || (target !== frame && !dom.contains(target))) return;
          if (target.closest(".bn-block-content")) return;
          const first = firstBlockOnScreen(view);
          if (!first || event.clientY >= first.getBoundingClientRect().top) return;
          if (!hasNoLine(view.state.doc.nodeAt(FIRST))) return;
          view.dispatch(lineAbove(view.state, FIRST));
          view.focus();
        },
        { signal },
      );
    },
  };
});
