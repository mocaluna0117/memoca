import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";

/**
 * What each of the / menu's blocks with text makes a line, by its key. A
 * heading says it is not a toggle: a toggle heading made a plain one would
 * otherwise stay a toggle, its isToggleable kept as the type changes.
 */
const LINE_TYPES: Record<string, PartialBlock> = {
  heading: { type: "heading", props: { level: 1, isToggleable: false } },
  heading_2: { type: "heading", props: { level: 2, isToggleable: false } },
  heading_3: { type: "heading", props: { level: 3, isToggleable: false } },
  heading_4: { type: "heading", props: { level: 4, isToggleable: false } },
  heading_5: { type: "heading", props: { level: 5, isToggleable: false } },
  heading_6: { type: "heading", props: { level: 6, isToggleable: false } },
  toggle_heading: { type: "heading", props: { level: 1, isToggleable: true } },
  toggle_heading_2: { type: "heading", props: { level: 2, isToggleable: true } },
  toggle_heading_3: { type: "heading", props: { level: 3, isToggleable: true } },
  quote: { type: "quote" },
  toggle_list: { type: "toggleListItem" },
  numbered_list: { type: "numberedListItem" },
  bullet_list: { type: "bulletListItem" },
  check_list: { type: "checkListItem" },
  paragraph: { type: "paragraph" },
  code_block: { type: "codeBlock" },
};

/**
 * The line the caret is in made `into`, its text, colours and what is inside
 * it kept, as the toolbar's type select does. Nothing for a block without a
 * line of text.
 */
export function turnLine(editor: BlockNoteEditor, into: PartialBlock) {
  const { block } = editor.getTextCursorPosition();
  if (!Array.isArray(block.content)) return;
  editor.updateBlock(block, into);
}

/**
 * The / menu's blocks with text (a heading, a list, a toggle, a quote, code,
 * plain text) made what the line the / was typed in is: a list item with
 * text made a toggle stays where it is, with its text. BlockNote makes the
 * line one only when it is empty, and otherwise puts a new, empty block
 * after it. The rest (a divider, a table, a file, columns) still goes after
 * a line with text, which it would take the place of.
 */
export function turningLines<T extends { key?: string; onItemClick: () => void }>(
  editor: BlockNoteEditor,
  items: T[],
): T[] {
  return items.map((item) => {
    const into = item.key === undefined ? undefined : LINE_TYPES[item.key];
    return into ? { ...item, onItemClick: () => turnLine(editor, into) } : item;
  });
}
