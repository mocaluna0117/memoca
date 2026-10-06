import { createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { type EditorState, TextSelection, type Transaction } from "prosemirror-state";

/** The list items Enter splits into two of the same. */
const ITEMS = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);

/** What an item has of its own that the one Enter makes is not to have: its tick, where its numbers start. */
const OWN = new Set(["checked", "start"]);

/** A list item's line, as ProseMirror has it, if `content` is one. */
const isItem = (content: Node) => ITEMS.has(content.type.name);

/**
 * Enter in a list item with text: the item split into two of the same, as
 * BlockNote does, but with text selected too (BlockNote makes the second a
 * paragraph then) and with its colours and alignment going on into the
 * second (BlockNote leaves them with the first). Not its tick, nor where
 * its numbers start. Null for anything else, an empty item (made a
 * paragraph, by BlockNote) among it.
 */
export function enterInItem(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $from, $to } = selection;
  if (!isItem($from.parent) || !isItem($to.parent)) return null;
  if (selection.empty && $from.parent.content.size === 0) return null;
  const tr = state.tr.deleteSelection();
  const $at = tr.selection.$from;
  const content = $at.parent;
  const container = $at.node($at.depth - 1);
  if (!isItem(content) || container.type.name !== "blockContainer") return null;
  const attrs = Object.fromEntries(
    Object.entries(content.attrs).filter(([name]) => !OWN.has(name)),
  );
  tr.split($at.pos, 2, [
    // A new block, with an id of its own.
    { type: container.type, attrs: { ...container.attrs, id: null } },
    { type: content.type, attrs },
  ]);
  return tr.scrollIntoView();
}

/** Where Tab is left to what has the block: a table's cells, a code block's indent. */
const KEEPS_TAB = new Set(["table", "codeBlock"]);

/**
 * Enter and Tab in lists, where BlockNote's own fall short: see
 * {@link enterInItem}. And Tab or Shift+Tab with the caret in a line that
 * cannot go in or out a step (the first item of a list, a line at the top):
 * nothing, as in a word processor. BlockNote leaves it to the browser
 * then, which takes the caret out of the note to the next button.
 */
export const listKeys = createExtension(({ editor }) => {
  /** Tab kept from the browser: with the caret alone in a line of text that cannot move. */
  const hold = (can: () => boolean) => {
    const { selection } = editor.prosemirrorState;
    if (!(selection instanceof TextSelection) || !selection.empty) return false;
    if (KEEPS_TAB.has(editor.getTextCursorPosition().block.type)) return false;
    return !can();
  };
  return {
    key: "memocaListKeys",
    runsBefore: [
      "bullet-list-item-shortcuts",
      "numbered-list-item-shortcuts",
      "check-list-item-shortcuts",
    ],
    keyboardShortcuts: {
      Enter: () => {
        const view = editor.prosemirrorView;
        const tr = view && enterInItem(view.state);
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
      Tab: () => hold(() => editor.canNestBlock()),
      "Shift-Tab": () => hold(() => editor.canUnnestBlock()),
    },
  };
});
