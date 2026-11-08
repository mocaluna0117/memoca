import { createExtension } from "@blocknote/core";
import { Fragment, type Node } from "prosemirror-model";
import { type EditorState, Plugin, TextSelection, type Transaction } from "prosemirror-state";
import { uuidv4 } from "uuidv7";
import { ySyncPluginKey } from "y-prosemirror";

/** The one kind of block the Todo holds. */
const CHECK = "checkListItem";

/**
 * The id BlockNote gives a new editor's first block, the same on every
 * device: two devices beginning the Todo apart would each have an item of
 * it (see joinTodoLists). The Todo's are given ids of their own.
 */
const FIRST_ID = "initialBlockId";

/** A meta asking the Todo to put its blocks right, with no change of its own (as it is shown). */
export const TODO_TIDY = "memocaTodoTidy";

/** The list's blocks, at its top: each block's node, and where it starts. */
function topBlocks(doc: Node): { node: Node; pos: number }[] {
  const group = doc.firstChild;
  if (!group) return [];
  const blocks: { node: Node; pos: number }[] = [];
  group.forEach((node, offset) => blocks.push({ node, pos: 1 + offset }));
  return blocks;
}

const isContainer = (node: Node) => node.type.name === "blockContainer";
const itemOf = (container: Node) => container.firstChild;
const isChecked = (container: Node) =>
  isContainer(container) && itemOf(container)?.type.name === CHECK && itemOf(container)?.attrs.checked === true;

/**
 * Every block a Todo item: a line of text (a paragraph pasted, a heading)
 * made one, its text kept; anything else (an image, a table, a divider)
 * taken out. One left empty has an empty item put in it.
 */
function itemsOnly(tr: Transaction): void {
  const { schema } = tr.doc.type;
  const check = schema.nodes[CHECK];
  if (!check) return;
  const removals: { from: number; to: number }[] = [];
  tr.doc.descendants((node, pos, parent) => {
    if (node.type.name === "blockGroup") return true;
    // A block's own line, and the text in it: nothing below to look at.
    if (parent?.type.name !== "blockGroup") return false;
    if (!isContainer(node)) {
      // A row of columns, say: not an item.
      removals.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    if (node.attrs.id === FIRST_ID) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: uuidv4() });
    const item = itemOf(node);
    if (item && item.type !== check) {
      if (item.isTextblock) tr.setNodeMarkup(pos + 1, check, { checked: false });
      else removals.push({ from: pos, to: pos + node.nodeSize });
    }
    // On into the blocks inside it, if it has any.
    return true;
  });
  for (const { from, to } of removals.reverse()) tr.delete(from, to);
  const group = tr.doc.firstChild;
  if (group && group.childCount === 0) {
    const container = schema.nodes.blockContainer;
    if (container) tr.insert(1, container.create(null, check.create({ checked: false })));
  }
}

/**
 * The items done after those to do, each as it was among its own (a stable
 * partition): one just ticked goes to the top of the done, one unticked to
 * the foot of those to do. The caret stays in the item it was in.
 */
function doneLast(tr: Transaction): void {
  const group = tr.doc.firstChild;
  if (!group) return;
  const children: Node[] = [];
  group.forEach((child) => children.push(child));
  const ordered = [...children.filter((child) => !isChecked(child)), ...children.filter(isChecked)];
  if (ordered.every((child, at) => child === children[at])) return;
  const { selection } = tr;
  let inside: { node: Node; from: number; to: number } | null = null;
  let pos = 1;
  for (const child of children) {
    const end = pos + child.nodeSize;
    if (selection.from >= pos && selection.to <= end) {
      inside = { node: child, from: selection.from - pos, to: selection.to - pos };
    }
    pos = end;
  }
  tr.replaceWith(1, 1 + group.content.size, Fragment.fromArray(ordered));
  if (inside && selection instanceof TextSelection) {
    let at = 1;
    for (const child of ordered) {
      if (child === inside.node) break;
      at += child.nodeSize;
    }
    tr.setSelection(TextSelection.create(tr.doc, at + inside.from, at + inside.to));
  }
}

/** Each item's tick, by its block's id. */
function ticks(doc: Node): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const { node } of topBlocks(doc)) {
    const id = node.attrs.id as string | null | undefined;
    if (id) found.set(id, isChecked(node));
  }
  return found;
}

/**
 * What the Todo does with a change: every block an item, and, where an item
 * was ticked or unticked, the done after those to do. Not with a change of
 * Yjs's own (another device's, an undo): that device has put its blocks
 * right already, and an undo of a tick goes back where it was, not sorted
 * again on top of it.
 */
export function tidyTodo(transactions: readonly Transaction[], before: EditorState, after: EditorState) {
  if (transactions.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
  const asked = transactions.some((tr) => tr.getMeta(TODO_TIDY));
  if (!asked && !transactions.some((tr) => tr.docChanged)) return null;
  const tr = after.tr;
  itemsOnly(tr);
  const was = ticks(before.doc);
  const now = ticks(tr.doc);
  const flipped = [...now].some(([id, checked]) => was.has(id) && was.get(id) !== checked);
  if (flipped || asked) doneLast(tr);
  return tr.docChanged ? tr : null;
}

/** The caret's item and where it is in the list, if the caret is alone at a place in an item. */
function caretItem(state: EditorState) {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== CHECK || $from.depth < 2) return null;
  const containerPos = $from.before($from.depth - 1);
  const index = topBlocks(state.doc).findIndex((block) => block.pos === containerPos);
  return { $from, item: $from.parent, itemPos: $from.before($from.depth), containerPos, index };
}

/**
 * The quick note's Todo: every line a tick box, the done going to the foot
 * (see {@link tidyTodo}). And its keys: Enter in an empty item does nothing
 * (BlockNote would make it a line of text, put back as an item at once);
 * Backspace at an item's start joins it to the one above (an empty one goes);
 * ⌘ + Enter ticks the item, or unticks it, the caret going on to the next
 * to do, for the next ⌘ + Enter.
 */
export const todoOnly = createExtension(({ editor }) => {
  const view = () => editor.prosemirrorView;
  return {
    key: "memocaTodoOnly",
    runsBefore: ["check-list-item-shortcuts"],
    keyboardShortcuts: {
      Enter: () => {
        const state = view()?.state;
        const at = state && caretItem(state);
        return Boolean(at && at.item.content.size === 0);
      },
      Backspace: () => {
        const current = view();
        const at = current && caretItem(current.state);
        if (!current || !at || at.$from.parentOffset !== 0) return false;
        if (at.index <= 0) return true;
        const above = topBlocks(current.state.doc)[at.index - 1]!;
        const aboveItem = itemOf(above.node);
        if (!aboveItem?.isTextblock) return true;
        // The end of the item above: inside it, after its text.
        const end = above.pos + 1 + aboveItem.nodeSize - 1;
        const tr = current.state.tr;
        if (at.item.content.size === 0) {
          const container = current.state.doc.nodeAt(at.containerPos)!;
          tr.delete(at.containerPos, at.containerPos + container.nodeSize);
        } else {
          tr.delete(end, at.itemPos + 1);
        }
        tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView();
        current.dispatch(tr);
        return true;
      },
      "Mod-Enter": () => {
        const current = view();
        // Where the caret is in the page now: a click just before this key
        // may not have reached the editor's state yet (selectionchange comes
        // after), and the wrong item would be ticked.
        (current as unknown as { domObserver?: { flush?: () => void } } | undefined)?.domObserver?.flush?.();
        const at = current && caretItem(current.state);
        if (!current || !at) return false;
        const checked = at.item.attrs.checked === true;
        current.dispatch(
          current.state.tr.setNodeMarkup(at.itemPos, undefined, { ...at.item.attrs, checked: !checked }),
        );
        if (checked) return true;
        // Ticked, it has gone to the done: the caret to what took its place,
        // or the foot of those to do.
        const blocks = topBlocks(current.state.doc);
        const todo = blocks.filter((block) => !isChecked(block.node));
        const next = blocks[at.index] && !isChecked(blocks[at.index]!.node) ? blocks[at.index]! : todo.at(-1);
        if (!next) return true;
        const item = itemOf(next.node)!;
        const place = next === blocks[at.index] ? next.pos + 2 : next.pos + 1 + item.nodeSize - 1;
        const state = current.state;
        current.dispatch(state.tr.setSelection(TextSelection.create(state.doc, place)).scrollIntoView());
        return true;
      },
    },
    prosemirrorPlugins: [new Plugin({ appendTransaction: tidyTodo })],
  };
});
