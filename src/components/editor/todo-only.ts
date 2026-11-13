import { createExtension } from "@blocknote/core";
import { Fragment, type Node, type ResolvedPos } from "prosemirror-model";
import { AllSelection, type EditorState, Plugin, TextSelection, type Transaction } from "prosemirror-state";
import { uuidv4 } from "uuidv7";
import { ySyncPluginKey } from "y-prosemirror";
import { TODO_SORT, duesIn, enteredIn } from "@/components/editor/todo-due";
import { dueAt } from "@/lib/quick/todo-due";

/** The one kind of block the Todo's items are. */
const CHECK = "checkListItem";
/** The kind a line of an item's details is: text, with no tick box. */
const DETAIL = "paragraph";

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
/** An item's details: the block group under its line, if it has one. */
const detailsOf = (container: Node): Node | null => (container.childCount > 1 ? container.child(1) : null);
const isChecked = (container: Node) =>
  isContainer(container) && itemOf(container)?.type.name === CHECK && itemOf(container)?.attrs.checked === true;

/**
 * An item's details, as they are to be: every line under it, however far
 * in it was, one step in and a line of text (a tick box pasted or written
 * there, an item that was one before details were, made one), in the order
 * they read. Anything not text (an image) is left out. Those already as
 * they are to be are the same nodes, to tell nothing changed.
 */
function flatDetails(group: Node): Node[] {
  const { schema } = group.type;
  const container = schema.nodes.blockContainer!;
  const detail = schema.nodes[DETAIL]!;
  const lines: Node[] = [];
  const walk = (inner: Node) =>
    inner.forEach((child) => {
      if (!isContainer(child)) return;
      const line = itemOf(child);
      const id = child.attrs.id === FIRST_ID ? uuidv4() : child.attrs.id;
      if (line?.isTextblock) {
        const kept = line.type === detail && child.childCount === 1 && id === child.attrs.id;
        lines.push(kept ? child : container.create({ ...child.attrs, id }, detail.create(line.attrs, line.content)));
      }
      const deeper = detailsOf(child);
      if (deeper) walk(deeper);
    });
  walk(group);
  return lines;
}

/**
 * Every block at the list's top a Todo item, and every block under one a
 * line of its details: a line of text (a paragraph pasted, a heading) made
 * one, its text kept; anything else (an image, a table, a divider) taken
 * out. A list left empty has an empty item put in it.
 */
function itemsOnly(tr: Transaction): void {
  const { schema } = tr.doc.type;
  const check = schema.nodes[CHECK];
  const container = schema.nodes.blockContainer;
  const groupType = schema.nodes.blockGroup;
  if (!check || !container || !groupType) return;
  // From the foot up: what is changed further down leaves where the blocks
  // above start as it was.
  const tops = topBlocks(tr.doc);
  for (let at = tops.length - 1; at >= 0; at -= 1) {
    const { node, pos } = tops[at]!;
    const item = isContainer(node) ? itemOf(node) : null;
    if (!item?.isTextblock) {
      // A row of columns, an image: not an item.
      tr.delete(pos, pos + node.nodeSize);
      continue;
    }
    const group = detailsOf(node);
    if (group) {
      const lines = flatDetails(group);
      const same = lines.length === group.childCount && lines.every((line, index) => line === group.child(index));
      if (!same) {
        const groupPos = pos + 1 + item.nodeSize;
        if (lines.length === 0) tr.delete(groupPos, groupPos + group.nodeSize);
        else tr.replaceWith(groupPos, groupPos + group.nodeSize, groupType.create(group.attrs, lines));
      }
    }
    if (item.type !== check) tr.setNodeMarkup(pos + 1, check, { ...item.attrs, checked: false });
    if (node.attrs.id === FIRST_ID) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: uuidv4() });
  }
  const group = tr.doc.firstChild;
  if (group && group.childCount === 0) tr.insert(1, container.create(null, check.create({ checked: false })));
}

/**
 * The items to do in order of their dues, the soonest first, those with
 * none after them; then the done. Each as it was among its own otherwise (a
 * stable sort): one just ticked goes to the top of the done, one unticked
 * to the foot of those with its due. The caret stays in the item it was
 * in. An item's details go with it.
 */
function inOrder(tr: Transaction, dues: ReadonlyMap<string, string> | undefined): void {
  const group = tr.doc.firstChild;
  if (!group) return;
  const children: Node[] = [];
  group.forEach((child) => children.push(child));
  const at = (child: Node) => dueAt(dues?.get(child.attrs.id as string));
  const todo = children.filter((child) => !isChecked(child));
  if (dues && dues.size > 0) todo.sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));
  const ordered = [...todo, ...children.filter(isChecked)];
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
 * What the Todo does with a change: every block an item or a line of one's
 * details, and, where an item was ticked or unticked, or a due was set (a
 * TODO_SORT), the list put in order (see inOrder). Not as anything is
 * typed: a line just written stays where it is, under the item it was
 * written after. Not with a change of Yjs's own (another device's, an
 * undo): that device has put its blocks right already, and an undo of a
 * tick goes back where it was, not sorted again on top of it.
 */
export function tidyTodo(transactions: readonly Transaction[], before: EditorState, after: EditorState) {
  if (transactions.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
  const asked = transactions.some((tr) => tr.getMeta(TODO_TIDY) || tr.getMeta(TODO_SORT));
  if (!asked && !transactions.some((tr) => tr.docChanged)) return null;
  const tr = after.tr;
  itemsOnly(tr);
  const was = ticks(before.doc);
  const now = ticks(tr.doc);
  const flipped = [...now].some(([id, checked]) => was.has(id) && was.get(id) !== checked);
  if (flipped || asked) inOrder(tr, duesIn(after));
  return tr.docChanged ? tr : null;
}

/** The line the caret is alone in: an item's, or a line of one's details (and its item). */
type Line =
  | { kind: "item"; $from: ResolvedPos; text: Node; containerPos: number; container: Node; index: number }
  | {
      kind: "detail";
      $from: ResolvedPos;
      text: Node;
      containerPos: number;
      container: Node;
      /** Its item: where it starts, and where it is in the list. */
      itemPos: number;
      item: Node;
      index: number;
      /** Where it is among its item's details. */
      at: number;
    };

/** The caret's line, if the caret is alone at a place in one. */
export function lineAt(state: EditorState): Line | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  const text = $from.parent;
  if (!text.isTextblock) return null;
  // The list's group, its block, the block's line: an item's.
  if ($from.depth === 3) {
    return { kind: "item", $from, text, containerPos: $from.before(2), container: $from.node(2), index: $from.index(1) };
  }
  // …and the block's details, a block in them, its line: a detail's.
  if ($from.depth === 5) {
    return {
      kind: "detail",
      $from,
      text,
      containerPos: $from.before(4),
      container: $from.node(4),
      itemPos: $from.before(2),
      item: $from.node(2),
      index: $from.index(1),
      at: $from.index(3),
    };
  }
  return null;
}

const newItem = (state: EditorState, content?: Fragment) =>
  state.schema.nodes.blockContainer!.create(
    { id: uuidv4() },
    state.schema.nodes[CHECK]!.create({ checked: false }, content),
  );
const newDetail = (state: EditorState, content?: Fragment) =>
  state.schema.nodes.blockContainer!.create({ id: uuidv4() }, state.schema.nodes[DETAIL]!.create(null, content));

/**
 * Shift + Enter: a line of details, under the item (the first of its
 * details) or after the line of details the caret is in, what is after the
 * caret going into it.
 */
export function addDetail(state: EditorState): Transaction | null {
  const line = lineAt(state);
  if (!line) return null;
  const tr = state.tr;
  const after = line.text.content.cut(line.$from.parentOffset);
  if (after.size > 0) tr.delete(line.$from.pos, line.$from.end());
  const added = newDetail(state, after);
  let start: number;
  if (line.kind === "detail") {
    const at = tr.mapping.map(line.containerPos + line.container.nodeSize);
    tr.insert(at, added);
    start = at + 2;
  } else {
    const container = tr.doc.nodeAt(line.containerPos)!;
    if (detailsOf(container)) {
      const at = line.containerPos + 1 + itemOf(container)!.nodeSize + 1;
      tr.insert(at, added);
      start = at + 2;
    } else {
      const at = line.containerPos + container.nodeSize - 1;
      tr.insert(at, state.schema.nodes.blockGroup!.create(null, added));
      start = at + 3;
    }
  }
  return tr.setSelection(TextSelection.create(tr.doc, start)).scrollIntoView();
}

/**
 * Enter in a line of details: the next line of them, what is after the
 * caret going into it; in an empty one, out of the details, the line gone
 * and a new item after the item.
 */
function enterInDetail(state: EditorState, line: Extract<Line, { kind: "detail" }>): Transaction {
  if (line.text.content.size > 0) return addDetail(state)!;
  const tr = state.tr;
  const group = detailsOf(line.item)!;
  const groupPos = line.itemPos + 1 + itemOf(line.item)!.nodeSize;
  if (group.childCount === 1) tr.delete(groupPos, groupPos + group.nodeSize);
  else tr.delete(line.containerPos, line.containerPos + line.container.nodeSize);
  const end = tr.mapping.map(line.itemPos + line.item.nodeSize);
  tr.insert(end, newItem(state));
  return tr.setSelection(TextSelection.create(tr.doc, end + 2)).scrollIntoView();
}

/**
 * Enter in an item with details: the new item after them, what is after
 * the caret going into it, the details staying with the item they are of.
 * At the start of the line, the new, empty item goes above.
 */
function enterInItemWithDetails(state: EditorState, line: Extract<Line, { kind: "item" }>): Transaction {
  const tr = state.tr;
  if (line.$from.parentOffset === 0) return tr.insert(line.containerPos, newItem(state)).scrollIntoView();
  const after = line.text.content.cut(line.$from.parentOffset);
  if (after.size > 0) tr.delete(line.$from.pos, line.$from.end());
  const end = tr.mapping.map(line.containerPos + line.container.nodeSize);
  tr.insert(end, newItem(state, after));
  return tr.setSelection(TextSelection.create(tr.doc, end + 2)).scrollIntoView();
}

/**
 * Tab: the item made a line of the details of the item above, the last of
 * them; its own details going on after it. Null in the first item, or in a
 * line of details already.
 */
export function makeDetail(state: EditorState): Transaction | null {
  const line = lineAt(state);
  if (!line || line.kind !== "item" || line.index === 0) return null;
  const above = state.doc.firstChild!.child(line.index - 1);
  if (!isContainer(above) || !itemOf(above)?.isTextblock) return null;
  const abovePos = line.containerPos - above.nodeSize;
  const { schema } = state;
  const moved = schema.nodes.blockContainer!.create(
    line.container.attrs,
    schema.nodes[DETAIL]!.create(line.text.attrs, line.text.content),
  );
  const own = detailsOf(line.container);
  const lines = own ? Fragment.from(moved).append(own.content) : Fragment.from(moved);
  const tr = state.tr.delete(line.containerPos, line.containerPos + line.container.nodeSize);
  let start: number;
  if (detailsOf(above)) {
    const at = abovePos + above.nodeSize - 2;
    tr.insert(at, lines);
    start = at + 2;
  } else {
    const at = abovePos + above.nodeSize - 1;
    tr.insert(at, schema.nodes.blockGroup!.create(null, lines));
    start = at + 3;
  }
  return tr.setSelection(TextSelection.create(tr.doc, start + line.$from.parentOffset)).scrollIntoView();
}

/**
 * Shift + Tab: the line of details made an item, after its item; the lines
 * of details after it going with it, as its own. Null in an item.
 */
export function makeItem(state: EditorState): Transaction | null {
  const line = lineAt(state);
  if (!line || line.kind !== "detail") return null;
  const { schema } = state;
  const group = detailsOf(line.item)!;
  const groupPos = line.itemPos + 1 + itemOf(line.item)!.nodeSize;
  const after: Node[] = [];
  for (let at = line.at + 1; at < group.childCount; at += 1) after.push(group.child(at));
  const check = schema.nodes[CHECK]!.create({ ...line.text.attrs, checked: false }, line.text.content);
  const made = schema.nodes.blockContainer!.create(
    line.container.attrs,
    after.length > 0 ? [check, schema.nodes.blockGroup!.create(null, after)] : [check],
  );
  const tr = state.tr;
  if (line.at === 0) tr.delete(groupPos, groupPos + group.nodeSize);
  else tr.delete(line.containerPos, groupPos + group.nodeSize - 1);
  const end = tr.mapping.map(line.itemPos + line.item.nodeSize);
  tr.insert(end, made);
  return tr.setSelection(TextSelection.create(tr.doc, end + 2 + line.$from.parentOffset)).scrollIntoView();
}

/** Where the text of a block's own line ends. */
const textEnd = (containerPos: number, container: Node) => containerPos + 2 + itemOf(container)!.content.size;

/**
 * Backspace at the start of a line: joined to the line above it, as text is
 * (an empty one goes), the caret where they meet. The line above an item is
 * the last of the details of the item above, if it has any; an item's own
 * details go on after them. In the first item, nothing. Null where the
 * caret is not at a line's start.
 */
export function joinUp(state: EditorState): Transaction | null | "nothing" {
  const line = lineAt(state);
  if (!line || line.$from.parentOffset !== 0) return null;
  const tr = state.tr;
  if (line.kind === "detail") {
    const group = detailsOf(line.item)!;
    const target =
      line.at > 0
        ? textEnd(line.containerPos - group.child(line.at - 1).nodeSize, group.child(line.at - 1))
        : textEnd(line.itemPos, line.item);
    if (group.childCount === 1) {
      const groupPos = line.itemPos + 1 + itemOf(line.item)!.nodeSize;
      tr.delete(groupPos, groupPos + group.nodeSize);
    } else {
      tr.delete(line.containerPos, line.containerPos + line.container.nodeSize);
    }
    if (line.text.content.size > 0) tr.insert(target, line.text.content);
    return tr.setSelection(TextSelection.create(tr.doc, target)).scrollIntoView();
  }
  if (line.index === 0) return "nothing";
  const above = state.doc.firstChild!.child(line.index - 1);
  if (!isContainer(above) || !itemOf(above)?.isTextblock) return "nothing";
  const abovePos = line.containerPos - above.nodeSize;
  const aboveDetails = detailsOf(above);
  // An empty item above, with nothing under it: it is the one that goes,
  // and this one stays the block it was. An item's due and its reminders
  // are kept by its id: joined into the empty one (whose id was the one
  // left), the item lost them, or took the empty one's.
  if (!aboveDetails && itemOf(above)!.content.size === 0) {
    tr.delete(abovePos, abovePos + above.nodeSize);
    return tr.setSelection(TextSelection.create(tr.doc, abovePos + 2)).scrollIntoView();
  }
  const target = aboveDetails
    ? textEnd(abovePos + above.nodeSize - 2 - aboveDetails.lastChild!.nodeSize, aboveDetails.lastChild!)
    : textEnd(abovePos, above);
  // From the foot up, so that each step leaves where the next is as it was.
  tr.delete(line.containerPos, line.containerPos + line.container.nodeSize);
  const own = detailsOf(line.container);
  if (own) {
    if (aboveDetails) tr.insert(abovePos + above.nodeSize - 2, own.content);
    else tr.insert(abovePos + above.nodeSize - 1, own);
  }
  if (line.text.content.size > 0) tr.insert(target, line.text.content);
  return tr.setSelection(TextSelection.create(tr.doc, target)).scrollIntoView();
}

/** Reads where the caret is in the page now: a click just before a key may not have reached the editor's state yet. */
const flushDom = (view: unknown) =>
  (view as { domObserver?: { flush?: () => void } } | undefined)?.domObserver?.flush?.();

/**
 * The quick note's Todo: every line a tick box, the done going to the foot
 * (see {@link tidyTodo}), and under an item, lines of its details (an
 * explanation, a link), with no tick box. And its keys: Enter in an empty
 * item does nothing, and at the start of one puts an empty one above it (BlockNote would make it a line of text, put back as
 * an item at once); Shift + Enter starts a line of details; Tab makes an
 * item a line of the details of the one above, Shift + Tab a line of
 * details an item; Backspace at a line's start joins it to the line above;
 * ⌘ + Enter ticks the item (the one of the details the caret is in), or
 * unticks it, the caret going on to the next to do, for the next ⌘ + Enter.
 * ⌘A selects every line, as in a note.
 */
export const todoOnly = createExtension(({ editor }) => {
  const view = () => editor.prosemirrorView;
  /** Runs a change of the caret's line, if there is one to make. */
  const run = (make: (state: EditorState) => Transaction | null) => {
    const current = view();
    if (!current) return false;
    const tr = make(current.state);
    if (tr) current.dispatch(tr);
    return Boolean(tr);
  };
  return {
    key: "memocaTodoOnly",
    runsBefore: ["check-list-item-shortcuts", "memocaListKeys"],
    keyboardShortcuts: {
      Enter: () => {
        const current = view();
        const state = current?.state;
        const line = state && lineAt(state);
        if (!current || !state || !line) return false;
        // The item it was pressed in: the new one it makes is given its day (todo-due).
        const from = (line.kind === "detail" ? line.item : line.container).attrs.id as string | undefined;
        if (from) enteredIn(current, from);
        if (line.kind === "detail") return run((now) => enterInDetail(now, line));
        if (line.text.content.size === 0) return true;
        if (detailsOf(line.container)) return run((now) => enterInItemWithDetails(now, line));
        // At its start, an item with no details too: the new, empty item
        // above it, the item staying the block it is. BlockNote's split
        // would carry its text into a new block, its due and reminders
        // (kept by its id) left on the empty one above.
        if (line.$from.parentOffset === 0) {
          return run((now) => now.tr.insert(line.containerPos, newItem(now)).scrollIntoView());
        }
        return false;
      },
      "Shift-Enter": () => run(addDetail),
      // Every line, to delete or copy at once. Left to the browser, as in a
      // note, its select-all came back here as the caret where it was (the
      // tick boxes and due chips around the text), and nothing was selected.
      "Mod-a": () => {
        const current = view();
        if (!current) return false;
        current.dispatch(current.state.tr.setSelection(new AllSelection(current.state.doc)));
        return true;
      },
      // Kept in the Todo either way: the browser would take the caret out
      // of it, to the next button.
      Tab: () => {
        flushDom(view());
        run(makeDetail);
        return true;
      },
      "Shift-Tab": () => {
        flushDom(view());
        run(makeItem);
        return true;
      },
      Backspace: () => {
        const current = view();
        if (!current) return false;
        const tr = joinUp(current.state);
        if (tr === null) return false;
        if (tr !== "nothing") current.dispatch(tr);
        return true;
      },
      "Mod-Enter": () => {
        const current = view();
        // Where the caret is in the page now: a click just before this key
        // may not have reached the editor's state yet (selectionchange comes
        // after), and the wrong item would be ticked.
        flushDom(current);
        const at = current && lineAt(current.state);
        if (!current || !at) return false;
        const itemPos = (at.kind === "detail" ? at.itemPos : at.containerPos) + 1;
        const item = current.state.doc.nodeAt(itemPos);
        if (item?.type.name !== CHECK) return false;
        const checked = item.attrs.checked === true;
        current.dispatch(current.state.tr.setNodeMarkup(itemPos, undefined, { ...item.attrs, checked: !checked }));
        if (checked) return true;
        // Ticked, it has gone to the done: the caret to what took its place,
        // or the foot of those to do.
        const blocks = topBlocks(current.state.doc);
        const todo = blocks.filter((block) => !isChecked(block.node));
        const next = blocks[at.index] && !isChecked(blocks[at.index]!.node) ? blocks[at.index]! : todo.at(-1);
        if (!next) return true;
        const place = next === blocks[at.index] ? next.pos + 2 : textEnd(next.pos, next.node);
        const state = current.state;
        current.dispatch(state.tr.setSelection(TextSelection.create(state.doc, place)).scrollIntoView());
        return true;
      },
    },
    prosemirrorPlugins: [new Plugin({ appendTransaction: tidyTodo })],
  };
});
