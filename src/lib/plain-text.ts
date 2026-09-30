import type { BlockNoteEditor } from "@blocknote/core";

/** A ProseMirror node, as BlockNote's editor holds its document. */
type Node = BlockNoteEditor["prosemirrorState"]["doc"];

/** A node's text from `start` to `end` within it, a line break within it as a line break. */
function textOf(node: Node, start = 0, end = node.content.size): string {
  return node.textBetween(start, end, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : ""));
}

/** How many blocks a position is nested in, beyond the first: blockContainer a level. */
function levelAt($pos: ReturnType<Node["resolve"]>): number {
  let containers = 0;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === "blockContainer") containers += 1;
  }
  return Math.max(0, containers - 1);
}

/** A table cell's text, on the one line its row is. */
function cellText(cell: Node): string {
  return textOf(cell).replace(/\n/g, " ");
}

/**
 * The text of what is selected in a note, as it reads on the screen, for
 * pasting into an app that takes plain text only (a chat, a mail, a text
 * editor). BlockNote writes Markdown there instead: a line break within a
 * paragraph as a backslash at the end of the line, a blank line between
 * every two paragraphs, `*` for a bullet, and escapes before marks such as
 * `_` or `*` in the text.
 *
 * One line a block, and a line of its own for each line break within one;
 * an empty block is an empty line; a table's row is a line, its cells
 * apart by tabs. Taken from more than one block, a list item keeps its mark
 * (・, 1., ☐ or ☑) and a nested block its indent (counted from the least
 * nested block taken); from within one block, it is just the text
 * selected. A block the selection only touches the edge of (ending at the
 * start of the next line, say) is left out. Blocks with no text (images,
 * files) leave nothing.
 */
export function plainTextBetween(doc: Node, from: number, to: number): string {
  const lines: { text: string; mark: string; level: number }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "tableRow") {
      // Its cells the selection takes more than the edge of, a tab between them.
      const cells: string[] = [];
      node.forEach((cell, offset) => {
        // Its text, inside its paragraph, inside the cell, inside the row.
        const start = pos + 1 + offset + 2;
        const end = start + cell.content.size - 2;
        if (start < to && end > from) cells.push(cellText(cell));
      });
      if (cells.length > 0) {
        lines.push({ text: cells.join("\t"), mark: "", level: levelAt(doc.resolve(pos)) });
      }
      return false;
    }
    if (!node.isTextblock) return true;
    const inside = pos + 1;
    const after = pos + node.nodeSize - 1;
    // Touched only at its edge: where the selection ends, or starts.
    if (inside >= to || after <= from) return false;
    const $pos = doc.resolve(pos);
    const text = textOf(node, Math.max(from, inside) - inside, Math.min(to, after) - inside);
    lines.push({ text, mark: markOf(node, $pos), level: levelAt($pos) });
    return false;
  });
  if (lines.length === 1) return lines[0]!.text;
  const least = Math.min(...lines.map((line) => line.level));
  return lines
    .map(({ text, mark, level }) => {
      const indent = "  ".repeat(level - least);
      // A line break within a list item goes on under its text, not its mark,
      // as wide as the mark: ・ is as wide as a full-width space.
      const under = indent + Array.from(mark, (char) => (char <= "\u00ff" ? " " : "　")).join("");
      return indent + mark + text.split("\n").join(`\n${under}`);
    })
    .join("\n");
}

/** A selection, as ProseMirror has it: of text, of a node, or of a table's cells. */
type Selection = {
  from: number;
  to: number;
  /** Only a selection of a table's cells has it. */
  forEachCell?: (f: (cell: Node, pos: number) => void) => void;
};

/**
 * The text of a selection: of cells of a table, a row a line and a tab
 * between cells (ProseMirror's from and to span only one of them); of
 * anything else, as {@link plainTextBetween} has it.
 */
export function plainTextOf(doc: Node, selection: Selection): string {
  if (!selection.forEachCell) return plainTextBetween(doc, selection.from, selection.to);
  const rows = new Map<number, string[]>();
  selection.forEachCell((cell, pos) => {
    const row = doc.resolve(pos).start();
    rows.set(row, [...(rows.get(row) ?? []), cellText(cell)]);
  });
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, cells]) => cells.join("\t"))
    .join("\n");
}

/** The mark a block's line starts with: a list item's, or none. */
function markOf(node: Node, $pos: ReturnType<Node["resolve"]>): string {
  switch (node.type.name) {
    case "bulletListItem":
      return "・";
    case "checkListItem":
      return node.attrs.checked ? "☑ " : "☐ ";
    case "numberedListItem":
      return `${numberOf($pos)}. `;
    default:
      return "";
  }
}

/**
 * A numbered item's number: the one its run of numbered items starts at, and
 * then one more for each item before it in the run, as BlockNote numbers them.
 */
function numberOf($pos: ReturnType<Node["resolve"]>): number {
  // $pos is inside the item's blockContainer; its group is one level up.
  const containerDepth = $pos.depth;
  const group = $pos.node(containerDepth - 1);
  let index = $pos.index(containerDepth - 1);
  let before = 0;
  let start = 1;
  while (index >= 0) {
    const content = group.child(index).firstChild;
    if (content?.type.name !== "numberedListItem") break;
    start = Number(content.attrs.start) || 1;
    if (index < $pos.index(containerDepth - 1)) before += 1;
    index -= 1;
  }
  return start + before;
}
