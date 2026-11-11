import type { Block, BlockNoteEditor, PartialBlock } from "@blocknote/core";

/**
 * A quick note's lines moved into the Todo (src/components/notes/
 * quick-capture.tsx, moveToTodo): which they are, taking them out of the
 * tab, and putting them back for 元に戻す. Lines indented under another are
 * found and put back where they were, as lines at the top are; what has no
 * line of text (an image, a table, a file) stays in the tab, where its line
 * was.
 */

/** Where lines taken out go back: after the line before them, before the one after, or into the line they were under. */
export type LinesAnchor = { id: string; place: "after" | "before" | "inside" } | null;

/** The lines to move, and what moving them leaves. */
export type LinesTaken = {
  blocks: Block[];
  /** Every line of the tab: all of it moved. */
  all: boolean;
  anchor: LinesAnchor;
  /** Something among them, however far in, has no line of text: it stays in the tab. */
  keepsSomething: boolean;
};

const hasText = (block: Block) => Array.isArray(block.content);

function holdsNonText(blocks: Block[]): boolean {
  return blocks.some((block) => !hasText(block) || holdsNonText(block.children));
}

/** What is under these with no line of text, however far in, each on its own, as new blocks. */
function nonTextUnder(blocks: Block[]): PartialBlock[] {
  return blocks.flatMap((block): PartialBlock[] => {
    const own: PartialBlock[] = [];
    // As a new block (a table's cells kept, its content).
    if (!hasText(block)) own.push({ type: block.type, props: block.props, content: block.content } as PartialBlock);
    return [...own, ...nonTextUnder(block.children)];
  });
}

/** Lines as they go back: what had no text in it left out (it never went). */
function linesOnly(blocks: Block[]): PartialBlock[] {
  return blocks
    .filter(hasText)
    .map((block) => ({ ...block, children: linesOnly(block.children) }) as PartialBlock);
}

/** The lines selected (however far in), or, with none, all of them. */
export function linesForTodo(editor: BlockNoteEditor): LinesTaken {
  const all = editor.document;
  const state = editor.prosemirrorView?.state;
  const selected = state && !state.selection.empty ? editor.getSelection()?.blocks : undefined;
  if (!selected || selected.length === 0) {
    return { blocks: all, all: true, anchor: null, keepsSomething: holdsNonText(all) };
  }
  const ids = new Set(selected.map((block) => block.id));
  const before = editor.getPrevBlock(selected[0]!);
  const after = editor.getNextBlock(selected.at(-1)!);
  const parent = editor.getParentBlock(selected[0]!);
  const anchor: LinesAnchor = before
    ? { id: before.id, place: "after" }
    : after
      ? { id: after.id, place: "before" }
      : parent
        ? { id: parent.id, place: "inside" }
        : null;
  return {
    blocks: selected,
    all: all.every((block) => ids.has(block.id)),
    anchor,
    keepsSomething: holdsNonText(selected),
  };
}

/**
 * Takes these lines out of the tab, wherever they are in it: what is under
 * one with no text in it (an image) left in its place. All of the tab gone:
 * an empty line left, to write the next in.
 */
export function removeLines(editor: BlockNoteEditor, ids: string[]): void {
  editor.transact(() => {
    for (const id of ids) {
      // Gone already, with a line it was under.
      const block = editor.getBlock(id);
      if (!block) continue;
      const kept = nonTextUnder(block.children);
      if (kept.length > 0) {
        editor.replaceBlocks([block], kept);
      } else if (editor.document.length === 1 && editor.document[0]!.id === block.id) {
        editor.replaceBlocks([block], [{ type: "paragraph" }]);
      } else {
        editor.removeBlocks([block]);
      }
    }
  });
}

/** Puts lines taken out back where they were (into an empty tab, as its lines; with nowhere found, at its top). */
export function putBackLines(editor: BlockNoteEditor, blocks: Block[], anchor: LinesAnchor): void {
  const lines = linesOnly(blocks);
  if (lines.length === 0) return;
  const document = editor.document;
  const first = document[0];
  const empty =
    document.length === 1 &&
    first?.type === "paragraph" &&
    Array.isArray(first.content) &&
    first.content.length === 0 &&
    first.children.length === 0;
  const target = anchor ? editor.getBlock(anchor.id) : undefined;
  editor.transact(() => {
    if (empty) editor.replaceBlocks(document, lines);
    else if (target && anchor?.place === "inside") editor.updateBlock(target, { children: [...target.children, ...lines] });
    else if (target && anchor) editor.insertBlocks(lines, target, anchor.place === "before" ? "before" : "after");
    else if (first) editor.insertBlocks(lines, first, "before");
  });
}
