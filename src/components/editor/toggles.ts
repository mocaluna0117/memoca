import {
  type BlockNoteEditor,
  type ComputeDropPositionContext,
  createExtension,
  selectedFragmentToHTML,
} from "@blocknote/core";
import type { Node, Slice } from "prosemirror-model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { uncover } from "@/components/editor/stuck-toggles";

/**
 * Toggles (a toggle list item, or a heading made one) as Notion has them,
 * where BlockNote does otherwise:
 *
 * - Enter in a toggle's line keeps what is inside it inside it. BlockNote
 *   splits the line and gives the lower half everything inside, which then
 *   sits in a new toggle, or under a paragraph for a heading. Open, the text
 *   after the caret starts a line of its own first inside it; closed, a new
 *   line after it (a toggle for a toggle, a paragraph for a heading); at the
 *   start of the line, an empty line before it.
 * - A block dragged by its handle to the lower half of an open toggle's
 *   line (or to its "add a block" button, open and empty) goes in, first.
 *   BlockNote only ever puts it before or after the toggle, so an empty one
 *   can never be given anything by dragging. To the lower half of a closed
 *   one's line, it goes after it (and all that is hidden inside it), where
 *   BlockNote, counting what is hidden, puts it before.
 * - Copied or cut with its line all selected, a closed toggle takes what is
 *   hidden inside it along, where BlockNote takes the line alone. See
 *   {@link copyRange}.
 * - Backspace in an empty line inside an open toggle takes the line away,
 *   the caret to the end of the line above it, as anywhere else in a note.
 *   BlockNote moves the line out of the toggle instead, and (were it the
 *   last there) closes the toggle. Nor does an open toggle close when what
 *   was inside it is all taken out some other way: open, it shows its "add
 *   a block" button, as BlockNote has a new one.
 * - ⌘/Ctrl+Enter opens or closes the toggle the caret is in: in its line, or
 *   anywhere inside it, however far down. Its line stays at the top of the
 *   screen as what is inside it is scrolled past (globals.css, and
 *   stuck-toggles.ts), for its ▼ to be in reach too; closed, it is brought
 *   back into view.
 */

/** A toggle's line: a toggle list item, or a heading that is one. */
export function isToggle(content: Node | null | undefined): boolean {
  if (!content) return false;
  return (
    content.type.name === "toggleListItem" ||
    (content.type.name === "heading" && content.attrs.isToggleable === true)
  );
}

/** A block (blockContainer) and where it is. */
type Found = { node: Node; pos: number };

/** Where the blockContainer holding `$pos` is, and it, if it is a toggle's. */
function toggleAround(state: EditorState, pos: number): Found | null {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === "blockContainer") {
      return isToggle(node.firstChild) ? { node, pos: $pos.before(depth) } : null;
    }
  }
  return null;
}

/** A block of its own, to go next to or inside another: as {@link blockOf} makes it. */
function blockOf(
  state: EditorState,
  type: "toggleListItem" | "paragraph",
  content?: Node["content"],
) {
  const { nodes } = state.schema;
  return nodes.blockContainer!.create(null, nodes[type]!.create(null, content));
}

/** The type of the line Enter makes beside a toggle: a toggle's, or a heading's paragraph. */
const siblingType = (content: Node) =>
  content.type.name === "toggleListItem" ? "toggleListItem" : "paragraph";

/**
 * Enter in a toggle's line, caret there (or text of it selected): the
 * transaction that keeps what is inside it inside it, or null to leave the
 * key to BlockNote (outside a toggle, or closed with nothing inside, where
 * it does as well, or an empty line with nothing inside).
 */
export function enterInToggle(
  state: EditorState,
  isOpen: (block: Found) => boolean,
): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) {
    return null;
  }
  const block = toggleAround(state, selection.from);
  const content = block?.node.firstChild;
  if (!block || !content || selection.$from.parent !== content) return null;
  const open = isOpen(block);
  const hasInside = block.node.childCount > 1;
  // An empty line with nothing inside: BlockNote makes it a paragraph, as for
  // a list. With something inside, it would take that out of the toggle.
  if (content.content.size === 0 && !hasInside) return null;
  if (!open && !hasInside) return null;

  const tr = state.tr.deleteSelection();
  const at = tr.selection.$from;
  const offset = at.parentOffset;
  const textStart = block.pos + 2;

  if (offset === 0 && at.parent.content.size > 0) {
    // At the start: an empty line before it, the caret staying with its text.
    tr.insert(block.pos, blockOf(state, siblingType(content)));
    return tr.scrollIntoView();
  }

  const lineEnd = textStart + at.parent.content.size;
  const rest = at.parent.content.cut(offset);
  tr.delete(textStart + offset, lineEnd);
  const container = tr.doc.nodeAt(block.pos)!;
  const afterLine = block.pos + 1 + container.firstChild!.nodeSize;
  let caret: number;
  if (open) {
    // First inside it: at the start of its group, or in a group of its own.
    const line = blockOf(state, "paragraph", rest);
    if (container.childCount > 1) {
      tr.insert(afterLine + 1, line);
      caret = afterLine + 1;
    } else {
      tr.insert(afterLine, state.schema.nodes.blockGroup!.create(null, line));
      caret = afterLine + 1;
    }
  } else {
    // After it, and after all that is inside it.
    const end = block.pos + container.nodeSize;
    tr.insert(end, blockOf(state, siblingType(content), rest));
    caret = end;
  }
  // Inside the new block's line: past the blockContainer and its content's start.
  tr.setSelection(TextSelection.create(tr.doc, caret + 2));
  return tr.scrollIntoView();
}

/**
 * The range to copy (or cut) for a selection: past the end of a closed
 * toggle's line, to the end of what is hidden inside it, when the selection
 * takes all of the line (from its start, or before) and ends there (or only
 * touches the start of the next line). Otherwise, null: the selection as it
 * is. An open toggle's line is taken as selected: what is inside it is
 * there to be selected, or not. The toggle furthest out wins.
 */
export function copyRange(
  doc: Node,
  from: number,
  to: number,
  isOpen: (block: Found) => boolean,
): { from: number; to: number } | null {
  if (from >= to) return null;
  let end = -1;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    const content = node.firstChild;
    if (!isToggle(content) || node.childCount < 2 || isOpen({ node, pos })) return true;
    const lineStart = pos + 2;
    const lineEnd = lineStart + content!.content.size;
    const blockEnd = pos + node.nodeSize;
    if (
      from <= lineStart &&
      // An empty line only touched at its start, as a selection to the start
      // of the next line is, is not taken.
      to > lineStart &&
      to >= lineEnd &&
      to < blockEnd &&
      doc.textBetween(lineEnd, to) === "" &&
      blockEnd > end
    ) {
      end = blockEnd;
    }
    return true;
  });
  return end > to ? { from, to: end } : null;
}

/**
 * Cuts a range {@link copyRange} gave. Starting at a toggle's line, the
 * toggle goes as a whole (an empty line in its place if it was all there
 * was); from a line before it, what is left of that line stays.
 */
export function cutRange(state: EditorState, range: { from: number; to: number }): Transaction {
  const block = toggleAround(state, range.from);
  const end = block ? block.pos + block.node.nodeSize : -1;
  if (!block || range.from !== block.pos + 2 || range.to !== end) {
    return state.tr.deleteRange(range.from, range.to).scrollIntoView();
  }
  const group = state.doc.resolve(block.pos).parent;
  if (group.childCount > 1) return state.tr.delete(block.pos, end).scrollIntoView();
  const tr = state.tr.replaceWith(block.pos, end, blockOf(state, "paragraph"));
  return tr.setSelection(TextSelection.create(tr.doc, block.pos + 2)).scrollIntoView();
}

/** A selection for reading a range from, never set on the editor. */
class RangeSelection extends Selection {
  map(): Selection {
    return this;
  }
  eq(other: Selection): boolean {
    return other.from === this.from && other.to === this.to;
  }
  toJSON() {
    return { type: "memocaRange", from: this.from, to: this.to };
  }
}

/**
 * What BlockNote puts on the clipboard for a range (its own HTML, HTML for
 * other apps, Markdown), as for a selection of it: the editor's own
 * selection is left as it is.
 */
export function clipboardFor(
  editor: BlockNoteEditor,
  view: EditorView,
  range: { from: number; to: number },
) {
  const { doc } = view.state;
  const selection = new RangeSelection(doc.resolve(range.from), doc.resolve(range.to));
  const state = Object.create(view.state, { selection: { value: selection } }) as EditorState;
  const reading = Object.create(view, { state: { value: state } }) as EditorView;
  return selectedFragmentToHTML(reading, editor);
}

/** Whether a toggle's children are shown, as its button has them on the screen. */
export function isOpenOnScreen(view: EditorView, block: Found): boolean {
  const content = view.nodeDOM(block.pos + 1);
  const wrapper =
    content instanceof HTMLElement ? content.querySelector(".bn-toggle-wrapper") : null;
  return wrapper?.getAttribute("data-show-children") === "true";
}

/** Where a drop over a toggle's line puts what is dropped: first inside it, or after it. */
export type ToggleDrop = { block: Found; where: "inside" | "after" };

/**
 * The toggle a drag at this point of the screen puts blocks by: over the
 * lower half of its line (or, open and empty, its "add a block" button
 * below it), first inside it if it is open, after it if it is closed. Not
 * one being dragged, or inside what is. A point in the margin beside the
 * blocks (below a block's handle, say) counts as over the block it is
 * beside, as BlockNote's side menu has it.
 */
export function toggleDropTarget(
  view: EditorView,
  target: EventTarget | null,
  x: number,
  y: number,
  dragged: { from: number; to: number },
): ToggleDrop | null {
  let element = target instanceof Element && view.dom.contains(target) ? target : null;
  if (!element?.closest(".bn-block-content")) {
    const box = view.dom.getBoundingClientRect();
    if (y < box.top || y > box.bottom || x < box.left - 80 || x > box.right) return null;
    const beside = view.root.elementFromPoint?.(box.left + box.width / 2, y) ?? null;
    element = beside && view.dom.contains(beside) ? beside : null;
  }
  const content = element?.closest(".bn-block-content");
  const wrapper = content?.querySelector(".bn-toggle-wrapper");
  if (!content || !wrapper) return null;
  const line = wrapper.getBoundingClientRect();
  if (y < line.top + line.height / 2) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(content, 0);
  } catch {
    return null;
  }
  const block = toggleAround(view.state, pos);
  if (!block) return null;
  if (dragged.from <= block.pos && block.pos < dragged.to) return null;
  const open = wrapper.getAttribute("data-show-children") === "true";
  return { block, where: open ? "inside" : "after" };
}

/**
 * Where the blocks dragged are in the note: what the side menu's handle
 * drags (whole blocks, one after another), found by their ids, and all this
 * moves. Null for anything else (text, a file, blocks from another note),
 * which is left to BlockNote. Found in the note rather than taken from the
 * selection, which the handle sets when the drag starts but which does not
 * always last until it ends.
 */
export function draggedFrom(doc: Node, slice: Slice): { from: number; to: number } | null {
  if (slice.openStart !== 0 || slice.openEnd !== 0 || slice.content.childCount === 0) return null;
  const first = slice.content.firstChild!;
  let blocks = true;
  slice.content.forEach((node) => {
    if (node.type.name !== "blockContainer" || !node.attrs.id) blocks = false;
  });
  if (!blocks) return null;
  let from = -1;
  doc.descendants((node, pos) => {
    if (from >= 0) return false;
    if (node.type.name === "blockContainer" && node.attrs.id === first.attrs.id) from = pos;
    return from < 0;
  });
  if (from < 0) return null;
  const to = from + slice.content.size;
  if (to > doc.content.size) return null;
  const found = doc.slice(from, to);
  return found.openStart === 0 && found.openEnd === 0 && found.content.eq(slice.content)
    ? { from, to }
    : null;
}

/** Where dropped blocks go: first inside, or after, a toggle. */
function dropPos(drop: ToggleDrop): number {
  const { block, where } = drop;
  if (where === "after") return block.pos + block.node.nodeSize;
  const afterLine = block.pos + 1 + block.node.firstChild!.nodeSize;
  return block.node.childCount > 1 ? afterLine + 1 : afterLine;
}

/**
 * The add-a-block button lit as where a drop goes, and none once it does
 * not: a frame over it, beside the editor as the drop cursor is. Marked on
 * the button itself, it would be a change to the note's view, which
 * ProseMirror undoes by drawing the toggle again.
 */
let lit: HTMLElement | null = null;
function light(view: EditorView | null, button: Element | null) {
  const parent = view?.dom.offsetParent;
  if (!view || !button || !(parent instanceof HTMLElement)) {
    lit?.remove();
    lit = null;
    return;
  }
  if (!lit || lit.parentElement !== parent) {
    lit?.remove();
    lit = document.createElement("div");
    lit.className = "memoca-toggle-drop";
    parent.append(lit);
  }
  const box = button.getBoundingClientRect();
  const origin = parent.getBoundingClientRect();
  Object.assign(lit.style, {
    left: `${box.left - origin.left + parent.scrollLeft}px`,
    top: `${box.top - origin.top + parent.scrollTop}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
}

/**
 * The drop cursor's place, for blocks dragged by their handle: first inside
 * an open toggle, or after a closed one. Otherwise, BlockNote's. An open
 * toggle with nothing inside has its "add a block" button lit, as the
 * cursor alone, below its line, looks as it does for a drop after it.
 */
export function computeDropPosition({ view, event, defaultPosition }: ComputeDropPositionContext) {
  const { dragging } = view;
  const dragged = dragging?.move ? draggedFrom(view.state.doc, dragging.slice) : null;
  const drop = dragged
    ? toggleDropTarget(view, event.target, event.clientX, event.clientY, dragged)
    : null;
  const empty = drop?.where === "inside" && drop.block.node.childCount < 2;
  const content = empty ? view.nodeDOM(drop.block.pos + 1) : null;
  light(
    view,
    content instanceof HTMLElement ? content.querySelector(".bn-toggle-add-block-button") : null,
  );
  return drop ? { pos: dropPos(drop), orientation: "block-horizontal" as const } : defaultPosition;
}

/**
 * Moves what is dragged (blocks, by the side menu's handle: see
 * {@link draggedFrom}) to first inside, or after, a toggle. Null if it is
 * not that.
 */
export function dropByToggle(
  state: EditorState,
  drop: ToggleDrop,
  slice: Slice,
): Transaction | null {
  const dragged = draggedFrom(state.doc, slice);
  if (!dragged || (dragged.from <= drop.block.pos && drop.block.pos < dragged.to)) return null;
  const tr = state.tr.delete(dragged.from, dragged.to);
  const pos = tr.mapping.map(drop.block.pos);
  const container = tr.doc.nodeAt(pos);
  if (!container || !isToggle(container.firstChild)) return null;
  const block = { node: container, pos };
  const at = dropPos({ block, where: drop.where });
  if (drop.where === "inside" && container.childCount < 2) {
    tr.insert(at, state.schema.nodes.blockGroup!.create(null, slice.content));
  } else {
    tr.insert(at, slice.content);
  }
  // The blocks' first, past its group's opening if one was made for them.
  const first = drop.where === "inside" && container.childCount < 2 ? at + 1 : at;
  tr.setSelection(
    slice.content.childCount === 1
      ? NodeSelection.create(tr.doc, first)
      : TextSelection.near(tr.doc.resolve(first + 2)),
  );
  return tr.setMeta("uiEvent", "drop");
}

/**
 * Where the caret goes back to from a block: the end of the last line shown
 * of the block (`pos`, a blockContainer): the end of its last line inside,
 * however deep, unless that is out of sight in a closed toggle. A block of
 * no text (an image), selected.
 */
function endShown(doc: Node, pos: number, isOpen: (block: Found) => boolean): Selection {
  const container = doc.nodeAt(pos)!;
  const content = container.firstChild!;
  const shown =
    container.childCount > 1 && (!isToggle(content) || isOpen({ node: container, pos }));
  if (shown) {
    const group = container.child(1);
    const groupStart = pos + 1 + content.nodeSize;
    return endShown(doc, groupStart + group.content.size + 1 - group.lastChild!.nodeSize, isOpen);
  }
  if (content.isTextblock) return TextSelection.create(doc, pos + 1 + content.nodeSize - 1);
  // A table: the end of its last cell, as BlockNote has it.
  if (content.childCount > 0) return Selection.near(doc.resolve(pos + content.nodeSize), -1);
  return NodeSelection.create(doc, pos + 1);
}

/**
 * A line straight inside an open toggle, with nothing inside the line
 * itself, and the caret in it: where it is, and the toggle. Null otherwise.
 */
function lineInToggle(
  state: EditorState,
  isOpen: (block: Found) => boolean,
): { line: Found; toggle: Found; index: number; group: Node } | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== "paragraph") return null;
  // The line's block, its group, and the block holding that: the toggle.
  const depth = $from.depth - 1;
  if (depth < 3) return null;
  const container = $from.node(depth);
  if (container.type.name !== "blockContainer" || container.childCount > 1) return null;
  const toggle = { node: $from.node(depth - 2), pos: $from.before(depth - 2) };
  if (toggle.node.type.name !== "blockContainer" || !isToggle(toggle.node.firstChild)) return null;
  if (!isOpen(toggle)) return null;
  return {
    line: { node: container, pos: $from.before(depth) },
    toggle,
    index: $from.index(depth - 1),
    group: $from.node(depth - 1),
  };
}

/**
 * Backspace at the start of a line straight inside an open toggle (nothing
 * inside the line itself), as anywhere else in a note: the line joined to
 * the end of the line shown above it (the toggle's own, for its first), or,
 * empty, taken away, the caret there. BlockNote takes it out of the toggle
 * instead, with all the lines after it under it. Above it a block of no text
 * (an image) or one its text cannot join (a table, a code block for marked
 * text): the caret goes there, the line left as it is. Null for anything
 * else, left to BlockNote (which first makes a list item a paragraph).
 */
export function backspaceInToggle(
  state: EditorState,
  isOpen: (block: Found) => boolean,
): Transaction | null {
  const found = lineInToggle(state, isOpen);
  if (!found || state.selection.$from.parentOffset !== 0) return null;
  const { line, toggle, index, group } = found;
  const text = line.node.firstChild!.content;
  const above =
    index === 0
      ? TextSelection.create(state.doc, toggle.pos + 1 + toggle.node.firstChild!.nodeSize - 1)
      : endShown(state.doc, line.pos - group.child(index - 1).nodeSize, isOpen);
  const $above = above.$from;
  const joins =
    above instanceof TextSelection &&
    $above.depth >= 1 &&
    $above.node($above.depth - 1).type.name === "blockContainer" &&
    $above.parent.type.validContent($above.parent.content.append(text));
  if (text.size > 0 && !joins) return state.tr.setSelection(above).scrollIntoView();
  // The last line there: its group too, as a group is never empty. All
  // after where the caret goes, which stays where it is.
  const tr =
    group.childCount === 1
      ? state.tr.delete(line.pos - 1, line.pos + line.node.nodeSize + 1)
      : state.tr.delete(line.pos, line.pos + line.node.nodeSize);
  if (text.size === 0) return tr.setSelection(above.map(tr.doc, tr.mapping)).scrollIntoView();
  // Where they join: before the text brought up.
  tr.insert(above.from, text);
  return tr.setSelection(TextSelection.create(tr.doc, above.from)).scrollIntoView();
}

/**
 * Enter in an empty line straight inside an open toggle, lines after it
 * there: a new line after it, inside too. BlockNote takes the line out of
 * the toggle, with all the lines after it under it. In the last line, left
 * to BlockNote: out of it, as a way out.
 */
export function enterInEmptyLine(
  state: EditorState,
  isOpen: (block: Found) => boolean,
): Transaction | null {
  const found = lineInToggle(state, isOpen);
  if (!found || found.line.node.firstChild!.content.size > 0) return null;
  if (found.index === found.group.childCount - 1) return null;
  const after = found.line.pos + found.line.node.nodeSize;
  const tr = state.tr.insert(after, blockOf(state, "paragraph"));
  return tr.setSelection(TextSelection.create(tr.doc, after + 2)).scrollIntoView();
}

/**
 * The toggles open with something inside them before a change, and nothing
 * after it: for each, its id. By the ids BlockNote gives blocks.
 */
export function emptiedToggles(before: Node, after: Node): string[] {
  const filled = new Set<string>();
  before.descendants((node) => {
    if (node.type.name === "blockContainer" && isToggle(node.firstChild) && node.childCount > 1) {
      filled.add(node.attrs.id as string);
    }
    return !node.isTextblock;
  });
  const emptied: string[] = [];
  if (filled.size === 0) return emptied;
  after.descendants((node) => {
    if (
      node.type.name === "blockContainer" &&
      isToggle(node.firstChild) &&
      node.childCount < 2 &&
      filled.has(node.attrs.id as string)
    ) {
      emptied.push(node.attrs.id as string);
    }
    return !node.isTextblock;
  });
  return emptied;
}

/**
 * A toggle just closed with the caret inside it: the caret to the end of its
 * line, as Notion has it. Left inside, out of sight, it takes what is typed
 * next, and a click at the end of the line does not always bring it out.
 */
export function caretOutOfClosed(state: EditorState, block: Found): Transaction | null {
  const content = block.node.firstChild!;
  const afterLine = block.pos + 1 + content.nodeSize;
  const blockEnd = block.pos + block.node.nodeSize;
  const { from, to } = state.selection;
  if (block.node.childCount < 2 || to <= afterLine || from >= blockEnd) return null;
  return state.tr.setSelection(TextSelection.create(state.doc, afterLine - 1));
}

/**
 * The toggle ⌘/Ctrl+Enter opens or closes for a caret at `pos`: the nearest
 * one it is in, in its line or inside it. Null if it is in none.
 */
export function toggleAt(state: EditorState, pos: number): Found | null {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === "blockContainer" && isToggle(node.firstChild)) {
      return { node, pos: $pos.before(depth) };
    }
  }
  return null;
}

/**
 * The toggle ⌘/Ctrl+Enter opens or closes for the selection: as for a caret
 * where it ends, or, a block selected whole (as one is once dropped), the
 * block itself if it is one, not one it is in.
 */
export function toggleToFlip(state: EditorState): Found | null {
  const { selection } = state;
  return toggleAt(state, selection instanceof NodeSelection ? selection.from + 1 : selection.head);
}

/** A toggle's wrapper (its ▼ and line), on the screen, by its block's id. */
function wrapperOf(view: EditorView, id: string): Element | null {
  return view.dom.querySelector(
    `.bn-block[data-id="${CSS.escape(id)}"] > .bn-block-content .bn-toggle-wrapper`,
  );
}

/** A toggle's ▼ button, on the screen. */
function buttonOf(view: EditorView, block: Found): HTMLElement | null {
  const content = view.nodeDOM(block.pos + 1);
  return content instanceof HTMLElement
    ? content.querySelector<HTMLElement>(".bn-toggle-button")
    : null;
}

export const toggles = createExtension(({ editor }) => ({
  key: "memocaToggles",
  // Before BlockNote's own Enter for a toggle list item.
  runsBefore: ["toggle-list-item-shortcuts"],
  mount({ dom, root, signal }) {
    // The lit button, back as it was once the drag is over, wherever it ended.
    root.addEventListener("dragend", () => light(null, null), { signal });
    root.addEventListener("drop", () => light(null, null), { signal, capture: true });
    signal.addEventListener("abort", () => light(null, null));
    // After the toggle's own handler, on its button, has closed it.
    dom.addEventListener(
      "click",
      (event) => {
        const view = editor.prosemirrorView;
        const button =
          event.target instanceof Element ? event.target.closest(".bn-toggle-button") : null;
        const wrapper = button?.closest(".bn-toggle-wrapper");
        const content = wrapper?.closest(".bn-block-content");
        if (!view || !content || wrapper?.getAttribute("data-show-children") !== "false") return;
        let block: Found | null;
        try {
          block = toggleAround(view.state, view.posAtDOM(content, 0));
        } catch {
          return;
        }
        const tr = block && caretOutOfClosed(view.state, block);
        if (tr) view.dispatch(tr);
        // Closed from its line kept at the top, far down inside it: what is
        // inside it gone, the line itself is up out of sight. Back into view,
        // below the header where the page scrolls (scroll-margin-top), and
        // below the lines of those it is in, kept there too.
        content.scrollIntoView({ block: "nearest" });
        uncover(content);
      },
      { signal },
    );
  },
  keyboardShortcuts: {
    // As its ▼ does: the closing then goes as for a click (see above).
    "Mod-Enter": () => {
      const view = editor.prosemirrorView;
      const block = view && toggleToFlip(view.state);
      const button = block && buttonOf(view, block);
      if (!button) return false;
      button.click();
      return true;
    },
    Backspace: () => {
      const view = editor.prosemirrorView;
      if (!view) return false;
      const tr = backspaceInToggle(view.state, (block) => isOpenOnScreen(view, block));
      if (!tr) return false;
      view.dispatch(tr);
      return true;
    },
    Enter: () => {
      const view = editor.prosemirrorView;
      if (!view) return false;
      const isOpen = (block: Found) => isOpenOnScreen(view, block);
      const tr = enterInToggle(view.state, isOpen) ?? enterInEmptyLine(view.state, isOpen);
      if (!tr) return false;
      view.dispatch(tr);
      return true;
    },
  },
  prosemirrorPlugins: [
    new Plugin({
      // Open with something inside, and all of it taken out: kept open.
      // BlockNote closes it once told of the change, after this has seen
      // it: open again then, by its ▼, as it would be. Found again by its id
      // then, not held: a change after this one in the same go (another
      // device's, say) can draw it anew, closed as BlockNote has just noted.
      view: () => ({
        update(view, before) {
          if (view.state.doc.eq(before.doc)) return;
          const open = emptiedToggles(before.doc, view.state.doc).filter(
            (id) => wrapperOf(view, id)?.getAttribute("data-show-children") === "true",
          );
          if (open.length === 0) return;
          queueMicrotask(() => {
            for (const id of open) {
              const wrapper = wrapperOf(view, id);
              if (wrapper?.getAttribute("data-show-children") === "false") {
                wrapper.querySelector<HTMLElement>(".bn-toggle-button")?.click();
              }
            }
          });
        },
      }),
      props: {
        handleDrop(view, event, slice, moved) {
          light(null, null);
          if (!moved) return false;
          const dragged = draggedFrom(view.state.doc, slice);
          const drop =
            dragged && toggleDropTarget(view, event.target, event.clientX, event.clientY, dragged);
          if (!drop) return false;
          const tr = dropByToggle(view.state, drop, slice);
          if (!tr) return false;
          view.dispatch(tr);
          view.focus();
          return true;
        },
      },
    }),
  ],
}));
