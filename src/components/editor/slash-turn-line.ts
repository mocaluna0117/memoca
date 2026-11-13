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

/**
 * Whether the / of the menu now open (its query typed after it) was typed
 * straight after a word, not at a line's start nor after a space: where the
 * menu is there to make that line something else, and for nothing more.
 */
export function slashAfterWord(editor: BlockNoteEditor, query: string): boolean {
  const { $from } = editor.prosemirrorState.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  if (!before.endsWith(`/${query}`)) return false;
  const head = before.slice(0, before.length - query.length - 1);
  return head !== "" && !/\s$/.test(head);
}

/**
 * The / menu's items for where its / was typed. After a word, only those
 * that make the line something else (a heading, a list, a quote): the menu
 * opens there for that alone (きょうの予定/見出し), and with every item in
 * it, a / written between two words took the Enter after it whenever the
 * second was among the menu's names: 図/表 and Enter put a table in and
 * took 「/表」 away, 写真/画像 an image, 紙/メモ opened the links to notes,
 * and a template's name put the template in. At a line's start or after a
 * space, all of them, as before.
 */
export function itemsForSlash<T>(editor: BlockNoteEditor, query: string, items: T[]): T[] {
  if (!slashAfterWord(editor, query)) return items;
  return items.filter((item) => {
    // BlockNote's own items have a key; Memoca's (a link to a note, a template) have none.
    const { key } = item as { key?: string };
    return key !== undefined && key in LINE_TYPES;
  });
}
