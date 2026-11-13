import { createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { type EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { isOpenOnScreen, isToggle } from "@/components/editor/toggles";

/**
 * A line below where there was no way to one from the keyboard, and the
 * caret at the note's end from the empty space under it.
 *
 * - ↓ on the last line of a code block, or in the last row of a table,
 *   that has nothing under it (the note's last block): a line below it,
 *   with the caret in it. Enter stays inside both (a new line of code, a
 *   new line in the cell), and BlockNote's line under the last block is one
 *   to click, not a line the caret can go down to: a note ending in a code
 *   block could be gone on with only by Enter three times on an empty line
 *   of the code, or by a click on the narrow strip under it.
 * - a click (not a drag) in the note's pane under the editor's frame: the
 *   caret at the end of the note's last line, or in a new line where its
 *   last block has none (an image, a table). The frame is half the
 *   window's height at the least; under it, a click took the focus from
 *   the editor to the page, and what was typed next went nowhere.
 */

/** The blocks Enter does not leave: where ↓ at their end makes the line below. */
const STAYS_IN = new Set(["codeBlock", "table"]);

/** An empty line put at `pos` (between blocks), and the caret in it. */
function lineAt(state: EditorState, pos: number): Transaction {
  const { nodes } = state.schema;
  const line = nodes.blockContainer!.create(null, nodes.paragraph!.create());
  const tr = state.tr.insert(pos, line);
  return tr.setSelection(TextSelection.create(tr.doc, pos + 2)).scrollIntoView();
}

/**
 * ↓ with the caret alone on the last line of a code block, or in the last
 * row of a table (`atFoot`: on the last line of its cell, which the screen
 * knows), with nothing below to go down to: a line under it. Null anywhere
 * else, and ↓ is the browser's.
 */
export function lineBelow(state: EditorState, atFoot: () => boolean): Transaction | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  let depth = $from.depth;
  while (depth > 0 && $from.node(depth).type.name !== "blockContainer") depth -= 1;
  if (depth === 0) return null;
  const container = $from.node(depth);
  const content = container.firstChild;
  // With blocks of its own under it, ↓ goes to them.
  if (!content || !STAYS_IN.has(content.type.name) || container.childCount > 1) return null;
  if (content.type.name === "codeBlock") {
    const rest = $from.parent.textBetween($from.parentOffset, $from.parent.content.size);
    if (rest.includes("\n")) return null;
  } else {
    if ($from.index(depth + 1) !== content.childCount - 1 || !atFoot()) return null;
  }
  const after = $from.after(depth);
  if (Selection.findFrom(doc.resolve(after), 1, true)) return null;
  return lineAt(state, after);
}

/**
 * The caret at the note's end: at the end of its last line in sight (the
 * last of what is under its last block, but not inside a toggle that is
 * closed, `shut`: there it is the toggle's own line), or, where that is a
 * block with no line of its own (an image, a table, a row of columns), in a
 * new line under the note's last block.
 */
export function caretAtEnd(
  state: EditorState,
  shut: (block: { node: Node; pos: number }) => boolean = () => false,
): Transaction {
  const { doc } = state;
  let node = doc.lastChild?.lastChild ?? null;
  // Where the note's last block is: the last in the note's group.
  let pos = node ? doc.content.size - 1 - node.nodeSize : 0;
  while (node && node.type.name === "blockContainer" && node.childCount > 1 && !shut({ node, pos })) {
    const group = node.lastChild!;
    const last = group.lastChild;
    if (group.type.name !== "blockGroup" || !last) break;
    pos = pos + node.nodeSize - 2 - last.nodeSize;
    node = last;
  }
  const line = node?.type.name === "blockContainer" ? node.firstChild : null;
  if (line?.isTextblock) {
    return state.tr.setSelection(TextSelection.create(doc, pos + 1 + line.nodeSize - 1)).scrollIntoView();
  }
  return lineAt(state, doc.content.size - 1);
}

export const linesBelow = createExtension(({ editor }) => ({
  key: "memocaLinesBelow",
  keyboardShortcuts: {
    ArrowDown: () => {
      const view = editor.prosemirrorView;
      if (!view?.editable) return false;
      const tr = lineBelow(view.state, () => view.endOfTextblock("down"));
      if (!tr) return false;
      view.dispatch(tr);
      return true;
    },
  },
  mount({ dom, signal }) {
    // The note's pane (its scroller, in a note; none around a quick note,
    // whose own page takes its clicks).
    const pane = dom.closest('[data-scroll="note"]');
    if (!pane) return;
    const frame = dom.closest(".bn-container") ?? dom;
    let pressed: { x: number; y: number } | null = null;
    pane.addEventListener(
      "mousedown",
      (event) => {
        pressed =
          event instanceof MouseEvent && event.button === 0 && event.target === pane
            ? { x: event.clientX, y: event.clientY }
            : null;
      },
      { signal },
    );
    pane.addEventListener(
      "click",
      (event) => {
        const view = editor.prosemirrorView;
        if (!view?.editable || !(event instanceof MouseEvent) || event.target !== pane) return;
        // A click, not a drag, and under the editor (not beside it).
        if (!pressed || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4) return;
        if (event.clientY < frame.getBoundingClientRect().bottom) return;
        // Not into a toggle that is closed: its own line, the last in sight.
        view.dispatch(
          caretAtEnd(view.state, (block) => isToggle(block.node.firstChild) && !isOpenOnScreen(view, block)),
        );
        view.focus();
      },
      { signal },
    );
  },
}));
