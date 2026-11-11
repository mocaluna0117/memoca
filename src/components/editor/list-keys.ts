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
 * its numbers start: at the start of the line, the new, empty item goes
 * above, the text keeping its tick, and the numbers starting where they
 * did (the empty one first). Null for anything else, an empty item
 * (made a paragraph, by BlockNote) among it.
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
  // At the start of a line with text: the empty item goes above, and the
  // text keeps its item, its tick and its number with it. Split there, the
  // tick stayed on the empty line, and the text went on as a new, unticked
  // item (so with BlockNote's own Enter).
  if ($at.parentOffset === 0 && content.content.size > 0) {
    // Where a numbered list's numbers start goes with its first item, the
    // empty one now: BlockNote numbers a list from its first item's start
    // alone, and the text, the second, would have been numbered from 1.
    const start = content.type.name === "numberedListItem" ? (content.attrs.start as unknown) : undefined;
    const empty = container.type.create(
      { ...container.attrs, id: null },
      content.type.create(start ? { ...attrs, start } : attrs),
    );
    const textAt = $at.before($at.depth);
    tr.insert($at.before($at.depth - 1), empty);
    if (start) {
      tr.setNodeMarkup(tr.mapping.map(textAt), undefined, { ...content.attrs, start: undefined });
    }
    return tr.scrollIntoView();
  }
  tr.split($at.pos, 2, [
    // A new block, with an id of its own.
    { type: container.type, attrs: { ...container.attrs, id: null } },
    { type: content.type, attrs },
  ]);
  return tr.scrollIntoView();
}

/** Where Tab is left to what has the block: a table's cells, a code block's indent. */
const KEEPS_TAB = new Set(["table", "codeBlock"]);

/** How far Tab puts a code block's line in, as BlockNote's own Tab does at the caret. */
const CODE_INDENT = "  ";

/**
 * Tab or Shift+Tab in a code block, the lines the selection is in each put
 * in a step (two spaces at its start) or out one (up to two taken off);
 * Shift+Tab with the caret alone, its line. BlockNote's own Tab writes two
 * spaces over what is selected (the lines were lost), and it has no
 * Shift+Tab: the browser took the caret out of the note. A selection going
 * on past the code block: nothing, rather than anything written over.
 * Null where it is BlockNote's (Tab with the caret alone), or not in one.
 */
export function indentCode(state: EditorState, out: boolean): Transaction | "nothing" | null {
  const { selection } = state;
  const { $from, $to } = selection;
  const anchor = state.doc.resolve(selection.anchor).parent;
  const inCode = $from.parent.type.name === "codeBlock" || anchor.type.name === "codeBlock";
  if (!inCode) return null;
  if (!$from.sameParent($to) || $from.parent.type.name !== "codeBlock") return "nothing";
  if (selection.empty && !out) return null;
  const text = $from.parent.textContent;
  const start = $from.start();
  const from = $from.parentOffset;
  // A selection ending at a line's very start (whole lines, by Shift+↓) does not take that line in.
  let to = $to.parentOffset;
  if (to > from && text[to - 1] === "\n") to -= 1;
  const lines: number[] = [];
  for (let at = text.lastIndexOf("\n", from - 1) + 1; ; ) {
    lines.push(at);
    const next = text.indexOf("\n", at);
    if (next < 0 || next >= to) break;
    at = next + 1;
  }
  const tr = state.tr;
  // From the last line up, so that each place is as it was.
  for (const at of lines.reverse()) {
    if (out) {
      const spaces = /^ {1,2}|^\t/.exec(text.slice(at))?.[0].length ?? 0;
      if (spaces > 0) tr.delete(start + at, start + at + spaces);
    } else {
      tr.insertText(CODE_INDENT, start + at);
    }
  }
  return tr.docChanged ? tr : "nothing";
}

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
  /** Tab or Shift+Tab in a code block: see {@link indentCode}. Null outside one, and for BlockNote's own Tab. */
  const code = (out: boolean): boolean | null => {
    const view = editor.prosemirrorView;
    if (!view) return null;
    const tr = indentCode(view.state, out);
    if (tr === null) return null;
    if (tr !== "nothing") view.dispatch(tr);
    return true;
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
      Tab: () => code(false) ?? hold(() => editor.canNestBlock()),
      "Shift-Tab": () => code(true) ?? hold(() => editor.canUnnestBlock()),
    },
  };
});
