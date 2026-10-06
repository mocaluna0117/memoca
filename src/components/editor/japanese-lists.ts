import { createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { type EditorState, Plugin, type Transaction } from "prosemirror-state";

/**
 * A bullet written by hand at the start of a line: ・ (full or half width)
 * or •, after any indent, with any space after it. Not the first of a run
 * (・・・, as an ellipsis).
 */
const MARK = /^[ \t\u3000]*[・･•](?![・･•])[ \u3000]*/;

/** A line of a block's text: where it starts, the line break before it, and its bullet. */
type Line = { start: number; breakAt: number | null; mark: number };

/**
 * The lines of a block's text (a line break a line), each with the length
 * of the bullet written at its start, or 0.
 */
function linesOf(line: Node, start: number): Line[] {
  const lines: Line[] = [];
  let current: Line = { start, breakAt: null, mark: 0 };
  let first = true;
  line.forEach((node, offset) => {
    const at = start + offset;
    if (node.type.name === "hardBreak") {
      lines.push(current);
      current = { start: at + 1, breakAt: at, mark: 0 };
      first = true;
      return;
    }
    if (first && node.isText) current.mark = MARK.exec(node.text ?? "")?.[0].length ?? 0;
    first = false;
  });
  lines.push(current);
  return lines;
}

/** Whether a block's text has a line starting with a bullet written by hand. */
const hasMarks = (line: Node) => linesOf(line, 0).some(({ mark }) => mark > 0);

/**
 * The bullets written by hand in a bullet list item's text taken off, and
 * each line (after the first) that had one made an item of its own, in
 * `tr`, which has changed nothing before the item's end. Empty lines before
 * such a line go, not to be left at the end of the item before it.
 */
function unmark(tr: Transaction, container: Node, pos: number) {
  const line = container.firstChild!;
  const lines = linesOf(line, pos + 2);
  const { schema } = container.type;
  // From the last, so the positions of those before it stay as they are.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const { start, breakAt, mark } = lines[index]!;
    if (mark === 0) continue;
    tr.delete(start, start + mark);
    if (breakAt === null) continue;
    // Empty lines just before it, each a line break of its own.
    let from = breakAt;
    for (let before = index - 1; before > 0; before -= 1) {
      const empty = lines[before]!;
      if (empty.start !== from || empty.breakAt === null) break;
      from = empty.breakAt;
    }
    tr.delete(from, breakAt + 1);
    tr.split(from, 2, [
      { type: schema.nodes.blockContainer! },
      { type: line.type, attrs: line.attrs },
    ]);
  }
}

/** Whether a change is an input rule's (・ or - at the start of a line): left as it made it. */
const byInputRule = (tr: Transaction, state: EditorState) =>
  state.plugins.some((plugin) => {
    const meta = tr.getMeta(plugin) as { transform?: unknown } | undefined;
    return meta?.transform !== undefined;
  });

/**
 * Bullet list items with lines written with a bullet by hand (・), as text
 * pasted from elsewhere often has, just made so (by the toolbar, a
 * shortcut or a menu) or just pasted: the bullets taken off, as the list
 * has its own, and each line after the first that had one made an item of
 * its own. So a list written as text, selected, becomes a list at once.
 *
 * Not for what is pasted from Memoca itself, which keeps its ・ as it was.
 * An item already in a list, with none before, keeps a ・ typed at its
 * start; a ・ typed at the start of a line an input rule makes an item of
 * is left too, with the Backspace that takes it back.
 */
export function listFromMarks(
  transactions: readonly Transaction[],
  before: EditorState,
  after: EditorState,
  fromMemoca = false,
): Transaction | null {
  if (!transactions.some((tr) => tr.docChanged)) return null;
  // Not for a change from another device, already made there.
  if (transactions.some((tr) => tr.getMeta("y-sync$"))) return null;
  if (transactions.some((tr) => byInputRule(tr, after))) return null;
  // Pasted from elsewhere: a ・ in what Memoca itself copied was left there
  // on purpose, and stays.
  const pasted = !fromMemoca && transactions.some((tr) => tr.getMeta("uiEvent") === "paste");

  const found: { node: Node; pos: number }[] = [];
  after.doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    const line = node.firstChild;
    if (line?.type.name === "bulletListItem" && hasMarks(line)) found.push({ node, pos });
    return true;
  });
  if (found.length === 0) return null;
  const was = new Map<string, Node>();
  const ids = new Set(found.map(({ node }) => node.attrs.id as string));
  before.doc.descendants((node) => {
    if (node.type.name === "blockContainer" && ids.has(node.attrs.id)) {
      was.set(node.attrs.id, node.firstChild!);
    }
    return true;
  });
  const made = found.filter(({ node }) => {
    const line = was.get(node.attrs.id);
    if (!line) return pasted;
    if (line.type.name !== "bulletListItem") return true;
    return pasted && !hasMarks(line);
  });
  if (made.length === 0) return null;

  const tr = after.tr;
  // From the last: a change to one leaves the positions before it as they
  // were, and an item inside another is after the other's text.
  for (const { node, pos } of made.reverse()) unmark(tr, node, pos);
  return tr;
}

/** Whether the paste being made is of what Memoca copied: see japaneseLists' mount. */
let ownPaste = false;

/**
 * Lists as Japanese is typed: ・ at the start of a line (the key where / is,
 * with the input method on) makes it a bullet list item, as - and a space
 * do in BlockNote. At once, with no space after it, which the input method
 * would take to change the ・ into something else. Backspace straight after
 * takes it back to the ・ typed. Only a line of text: a heading stays a
 * heading, as with -, and a ・ typed at the start of a list item, a quote
 * or a toggle stays there, as the item it is (with - it would become a
 * bullet, its tick or what is inside it lost).
 *
 * And lines written with ・ at their start, made a bullet list together,
 * lose it: see {@link listFromMarks}.
 */
export const japaneseLists = createExtension({
  key: "memocaJapaneseLists",
  inputRules: [
    {
      find: /^\s?[・･]$/,
      replace({ editor }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type !== "paragraph") return undefined;
        return { type: "bulletListItem", props: {} };
      },
    },
  ],
  mount({ root, signal }) {
    // Before any editor has it: whether what is pasted is Memoca's own
    // (BlockNote's copy, from this note or another), for the change it
    // makes, straight after.
    root.addEventListener(
      "paste",
      (event) => {
        ownPaste =
          (event as ClipboardEvent).clipboardData?.types.includes("blocknote/html") ?? false;
        setTimeout(() => (ownPaste = false));
      },
      { capture: true, signal },
    );
  },
  prosemirrorPlugins: [
    new Plugin({
      appendTransaction: (transactions, before, after) =>
        listFromMarks(transactions, before, after, ownPaste),
    }),
  ],
});
