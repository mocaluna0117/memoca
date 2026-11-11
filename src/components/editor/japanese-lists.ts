import { type Extension, createExtension } from "@blocknote/core";
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
 * Where the transactions changed the document, as positions in the
 * document after them all: each step's range, mapped through the steps
 * after it, and widened by a position either way, so that a change at a
 * line's edge takes the line in.
 */
export function changedRanges(
  transactions: readonly Transaction[],
  size: number,
): [number, number][] {
  const ranges: [number, number][] = [];
  transactions.forEach((tr, k) => {
    tr.steps.forEach((step, i) => {
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        const rest = tr.mapping.slice(i + 1);
        let from = rest.map(newStart, -1);
        let to = rest.map(newEnd, 1);
        for (const later of transactions.slice(k + 1)) {
          from = later.mapping.map(from, -1);
          to = later.mapping.map(to, 1);
        }
        ranges.push([Math.max(0, from - 1), Math.min(size, to + 1)]);
      });
    });
  });
  return ranges;
}

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

  // Only where the change was: a note's every block, read with every key
  // typed, was most of what a key cost in a long note.
  const seen = new Map<string, { node: Node; pos: number }>();
  for (const [from, to] of changedRanges(transactions, after.doc.content.size)) {
    after.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name !== "blockContainer") return true;
      const line = node.firstChild;
      if (line?.type.name === "bulletListItem" && hasMarks(line)) {
        seen.set(node.attrs.id as string, { node, pos });
      }
      return true;
    });
  }
  const found = [...seen.values()];
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

/** The dashes the input method makes of - (ー), and the full-width ones: a bullet, with a space after. */
const DASHES = "ー－‐−―—";
/** Digits, half or full width. */
const DIGITS = "0-9０-９";

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
 * And what the input method makes of BlockNote's own shortcuts: ー, －, ＊
 * or ＋ and a space (half or full width) a bullet; １．, 1。 and a space a
 * numbered list, from that number; 「」 and a space a check list item,
 * 「x」 one ticked; ＃ to ＃＃＃ and a space a heading, ＞ and one a quote.
 * Not １、 nor ①: those begin sentences.
 *
 * And lines written with ・ at their start, made a bullet list together,
 * lose it: see {@link listFromMarks}.
 */
// 「」 and a space: a check list item, as [] and a space is; 「x」, 「×」
// or 「✓」: one ticked.
const CHECK_RULES: NonNullable<Extension["inputRules"]> = [
  {
    find: /^\s?「[\s　]*」\s$/,
    replace({ editor }) {
      const { block } = editor.getTextCursorPosition();
      if (block.type === "heading") return undefined;
      return { type: "checkListItem", props: { checked: false } };
    },
  },
  {
    find: /^\s?「[xXｘＸ×✓✔]」\s$/,
    replace({ editor }) {
      const { block } = editor.getTextCursorPosition();
      if (block.type === "heading") return undefined;
      return { type: "checkListItem", props: { checked: true } };
    },
  },
];

/**
 * The Todo's: 「」 and a space, and 「x」 and one, as the input method
 * types [] and [x], taken off the start of an item (its own lines are all
 * items, and the other lists' marks stay as they were typed).
 */
export const japaneseChecks = createExtension({ key: "memocaJapaneseChecks", inputRules: CHECK_RULES });

export const japaneseLists = createExtension({
  key: "memocaJapaneseLists",
  inputRules: [
    {
      find: /^\s?[・･•]$/,
      replace({ editor }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type !== "paragraph") return undefined;
        return { type: "bulletListItem", props: {} };
      },
    },
    // A space typed into a bullet item with nothing in it yet: the one a
    // Japanese list puts after its ・ (・　牛乳), which made the line an
    // item already, not kept at the item's start. One typed before text
    // already there stays.
    {
      find: /^\s$/,
      replace({ editor }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type !== "bulletListItem") return undefined;
        if (!Array.isArray(block.content) || block.content.length > 0) return undefined;
        return { type: "bulletListItem", props: block.props };
      },
    },
    // With the input method on, - comes out as ー (or －), * as ＊, + as ＋,
    // and the space after it as a full-width one: BlockNote's own rules
    // (-, *, + and a space) do not see them.
    {
      find: new RegExp(`^\\s?[${DASHES}＊＋]\\s$`),
      replace({ editor }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type === "heading") return undefined;
        return { type: "bulletListItem", props: {} };
      },
    },
    // １．(full width), 1。(the . the input method turns into 。), 12．: a
    // numbered list from that number, as "1." and a space is.
    {
      find: new RegExp(`^\\s?([${DIGITS}]+)[.．。]\\s$`),
      replace({ editor, match }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type === "heading") return undefined;
        const start = Number.parseInt(match[1]!.normalize("NFKC"), 10);
        return { type: "numberedListItem", props: start === 1 ? {} : { start } };
      },
    },
    ...CHECK_RULES,
    // ＃ (to ＃＃＃) and a space: a heading of that level, as # is; ＞ and a
    // space a quote, as > is (quotes.ts). A line of text, or a heading's
    // level changed, as BlockNote's own.
    {
      find: /^\s?(＃{1,3})\s$/,
      replace({ editor, match }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type !== "paragraph" && block.type !== "heading") return undefined;
        return { type: "heading", props: { level: match[1]!.length as 1 | 2 | 3 } };
      },
    },
    {
      find: /^\s?＞\s$/,
      replace({ editor }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type !== "paragraph") return undefined;
        return { type: "quote", props: {} };
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
