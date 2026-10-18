import { type BlockNoteEditor, type PartialBlock, createExtension } from "@blocknote/core";
import { SuggestionMenu } from "@blocknote/core/extensions";
import type { Fragment, Node, Slice } from "prosemirror-model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import {
  type Found,
  type Shown,
  blockAfter,
  blockAt,
  blockBefore,
  shownOn,
} from "@/components/editor/select-media";
import { clipboardFor } from "@/components/editor/toggles";
import { forThisSystem, plainTextBetween } from "@/lib/plain-text";

/**
 * Blocks chosen whole, as Notion has them: Esc in a line chooses its block
 * (the blocks a selection runs over, with one), ↑ and ↓ choose the one
 * before or after, Shift with them takes in more. Chosen, they are copied,
 * cut, pasted over, deleted (Backspace) or duplicated (⌘D) as blocks, what
 * is inside them (a closed toggle's hidden lines too) going with them, and
 * pasted back as blocks. Esc again, or Enter (to the end of the line), or a
 * click, lets them go.
 *
 * What is chosen is kept beside the editor's selection, which stays a caret
 * (hidden meanwhile): BlockNote's toolbars, and all that reads the caret's
 * block, go on as they do, and nothing typed (with the input method too)
 * can take the place of the blocks; typed, it goes in at the caret, and the
 * blocks are let go. They are let go with any change but the document's own
 * syncing, and kept through that.
 *
 * Chosen blocks are always side by side, in one group: taken in past either
 * end of it, the block it is in is chosen instead; a row of columns is
 * chosen as one.
 *
 * Blocks are chosen by a box too, dragged with the mouse from the margin
 * beside them or below them: those whose line it reaches, top to bottom
 * (and those between). A click there, not dragged, puts the caret in the
 * line beside it, as it did.
 */

/** The block it started from and the one it was taken to, each by where it is. */
export type Chosen = { anchor: number; head: number };

export const blockSelectKey = new PluginKey<Chosen | null>("memocaBlockSelect");

/** Blocks chosen whole: a block, or a row of columns (a column goes with its row). */
const CHOOSABLE = new Set(["blockContainer", "columnList"]);

/** The blocks a position is in, outermost first, that can be chosen. */
function chain(doc: Node, pos: number): Found[] {
  const $pos = doc.resolve(pos);
  const found: Found[] = [];
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
    if (CHOOSABLE.has(node.type.name)) found.push({ node, pos: $pos.before(depth) });
  }
  return found;
}

const whole = (block: Found) => ({ from: block.pos, to: block.pos + block.node.nodeSize });

/**
 * The blocks chosen from one block to another (each by where it is): the
 * two, and all side by side between them, in the group both are in, or the
 * block both are in.
 */
export function chosenRange(doc: Node, chosen: Chosen): { from: number; to: number } | null {
  const a = chain(doc, chosen.anchor + 1);
  const b = chain(doc, chosen.head + 1);
  if (a.length === 0 || b.length === 0) return null;
  let at = 0;
  while (at < a.length && at < b.length && a[at]!.pos === b[at]!.pos) at += 1;
  // One inside the other (or the same): the outer one.
  if (at === a.length || at === b.length) return whole((at === a.length ? a : b)[at - 1]!);
  // In different columns of a row: the row.
  if (doc.resolve(a[at]!.pos).start() !== doc.resolve(b[at]!.pos).start()) {
    return at > 0 ? whole(a[at - 1]!) : null;
  }
  const [first, last] = a[at]!.pos < b[at]!.pos ? [a[at]!, b[at]!] : [b[at]!, a[at]!];
  return { from: first.pos, to: last.pos + last.node.nodeSize };
}

/** Each block chosen, in order. */
export function chosenBlocks(doc: Node, range: { from: number; to: number }): Found[] {
  const found: Found[] = [];
  for (let pos = range.from; pos < range.to;) {
    const node = doc.nodeAt(pos);
    if (!node) break;
    found.push({ node, pos });
    pos += node.nodeSize;
  }
  return found;
}

/** The blocks a selection is in, chosen: the one the caret is in, or those it runs over. */
export function chosenFrom(state: EditorState): Chosen | null {
  const { $anchor, $head } = state.selection;
  const anchor = blockAt($anchor);
  const head = blockAt($head);
  if (!anchor || !head) return null;
  return { anchor: anchor.pos, head: head.pos };
}

/**
 * The blocks chosen after ↑ or ↓: the block before them or after them (as
 * read on the screen, a closed toggle's hidden lines left out), alone; or,
 * with Shift, the one chosen last taken a block further, those between with
 * it. Null at the top or the bottom.
 */
export function movedChoice(
  doc: Node,
  chosen: Chosen,
  dir: "up" | "down",
  extend: boolean,
  shown: Shown,
): Chosen | null {
  const range = chosenRange(doc, chosen);
  if (!range) return null;
  const blocks = chosenBlocks(doc, range);
  if (!extend) {
    const next =
      dir === "down"
        ? blockAfter(doc, blocks.at(-1)!, () => false)
        : blockBefore(doc, blocks[0]!, shown);
    return next ? { anchor: next.pos, head: next.pos } : null;
  }
  // Away from where it started, past what is chosen already (inside it);
  // towards it, a block back.
  const away = chosen.head === chosen.anchor || (dir === "down") === chosen.head > chosen.anchor;
  let head: Found | null = { node: doc.nodeAt(chosen.head)!, pos: chosen.head };
  do {
    head = dir === "down" ? blockAfter(doc, head, shown) : blockBefore(doc, head, shown);
  } while (head && away && head.pos >= range.from && head.pos < range.to);
  return head ? { anchor: chosen.anchor, head: head.pos } : null;
}

/** A block as BlockNote has it, with no id, nor any inside it: a new one, inserted. */
function withoutIds(block: PartialBlock): PartialBlock {
  const copy = { ...block } as PartialBlock & { id?: string };
  delete copy.id;
  return { ...copy, children: (block.children ?? []).map(withoutIds) } as PartialBlock;
}

/** Where a block is, by its id. */
function posOf(doc: Node, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (CHOOSABLE.has(node.type.name) && node.attrs.id === id) found = pos;
    return found === null;
  });
  return found;
}

const idsOf = (blocks: Found[]) => blocks.map((block) => block.node.attrs.id as string);

/**
 * A change of blocks (taken out, duplicated, pasted) undone on its own, as
 * one step: Yjs's undo takes in what comes within half a second of the last
 * change with it, the typing just before or after among it.
 */
export function ownStep(view: EditorView, change: () => void) {
  const undo = view.state.plugins
    .find((plugin) => (plugin as unknown as { key: string }).key === "y-undo$")
    ?.getState(view.state) as { undoManager?: { stopCapturing(): void } } | undefined;
  undo?.undoManager?.stopCapturing();
  change();
  undo?.undoManager?.stopCapturing();
}

/** The blocks chosen, if any, and they are. */
function current(view: EditorView) {
  const chosen = blockSelectKey.getState(view.state);
  const range = chosen ? chosenRange(view.state.doc, chosen) : null;
  return chosen && range ? { chosen, range, blocks: chosenBlocks(view.state.doc, range) } : null;
}

/** The blocks chosen, taken out; the caret to the end of the line before them, or the start of the one after. */
export function removeChosen(editor: BlockNoteEditor, view: EditorView) {
  const now = current(view);
  if (!now) return;
  const { doc } = view.state;
  const shown = shownOn(view);
  const before = blockBefore(doc, now.blocks[0]!, shown);
  const after = blockAfter(doc, now.blocks.at(-1)!, () => false);
  const all = now.range.from === 1 && now.range.to === doc.content.size - 1;
  ownStep(view, () =>
    editor.transact(() => {
      // The note always keeps a line.
      if (all) {
        const [line] = editor.replaceBlocks(idsOf(now.blocks), [
          { type: "paragraph" },
        ]).insertedBlocks;
        if (line) editor.setTextCursorPosition(line.id, "start");
        return;
      }
      editor.removeBlocks(idsOf(now.blocks));
      const to = before ?? after;
      // As in choose: from the handle's menu, the caret goes where it is taken.
      if (to && to.node.type.name === "blockContainer" && view.hasFocus()) {
        editor.setTextCursorPosition(to.node.attrs.id as string, before ? "end" : "start");
      }
    }),
  );
}

/** The blocks chosen, a copy of each after the last, chosen in their place. */
export function duplicateChosen(editor: BlockNoteEditor, view: EditorView) {
  const now = current(view);
  if (!now) return;
  const ids = idsOf(now.blocks);
  const copies = ids.map((id) => editor.getBlock(id)).filter((block) => block !== undefined);
  if (copies.length === 0) return;
  ownStep(view, () => editor.insertBlocks(copies.map(withoutIds), ids.at(-1)!, "after"));
  // The copies: right after what was chosen.
  const { doc } = view.state;
  const end = posOf(doc, ids.at(-1)!);
  if (end === null) return;
  const first = end + doc.nodeAt(end)!.nodeSize;
  let last = first;
  for (let i = 1; i < copies.length; i += 1) last += doc.nodeAt(last)!.nodeSize;
  choose(view, { anchor: first, head: last });
}

/** What blocks Memoca copied as blocks are marked with, on the clipboard. */
export const BLOCKS_TYPE = "memoca/blocks";

/**
 * Blocks pasted, whole (what {@link writeBlocks} put on the clipboard, read
 * back): the blocks, or null for anything else, such as text from within a
 * line.
 */
export function wholeBlocks(slice: Slice): Fragment | null {
  let { content, openStart, openEnd } = slice;
  while (content.childCount === 1 && content.firstChild!.type.name === "blockGroup") {
    content = content.firstChild!.content;
    openStart -= 1;
    openEnd -= 1;
  }
  if (openStart > 0 || openEnd > 0 || content.childCount === 0) return null;
  let whole = true;
  content.forEach((node) => {
    if (!CHOOSABLE.has(node.type.name)) whole = false;
  });
  return whole ? content : null;
}

/**
 * Blocks pasted, put as Notion puts them: in place of the blocks chosen; in
 * place of the empty line the caret is in; or after the block it is in (and
 * all inside it), not into its line. BlockNote puts them inside the line's
 * block, under it. The caret to the end of the last.
 */
export function placeBlocks(state: EditorState, content: Fragment): Transaction | null {
  const chosen = blockSelectKey.getState(state);
  let range = chosen ? chosenRange(state.doc, chosen) : null;
  if (!range) {
    const block = blockAt(state.selection.$from);
    if (!block) return null;
    const line = block.node.firstChild!;
    const empty =
      block.node.type.name === "blockContainer" &&
      line.isTextblock &&
      line.content.size === 0 &&
      block.node.childCount === 1;
    const end = block.pos + block.node.nodeSize;
    range = empty ? whole(block) : { from: end, to: end };
  }
  try {
    const tr = state.tr.replaceWith(range.from, range.to, content);
    tr.setSelection(Selection.near(tr.doc.resolve(range.from + content.size), -1));
    return tr.setMeta(blockSelectKey, null).scrollIntoView();
  } catch {
    // Where blocks cannot go (a row of columns into a column): as BlockNote pastes it.
    return null;
  }
}

/** The blocks chosen, written on a clipboard as Memoca's, as HTML and as text. */
export function writeBlocks(
  editor: BlockNoteEditor,
  view: EditorView,
  range: { from: number; to: number },
  data: DataTransfer,
) {
  const { clipboardHTML, externalHTML } = clipboardFor(editor, view, range);
  data.clearData();
  data.setData("blocknote/html", clipboardHTML);
  // Known again when pasted, to go in as blocks (placeBlocks).
  data.setData(BLOCKS_TYPE, "1");
  data.setData("text/html", externalHTML);
  data.setData(
    "text/plain",
    forThisSystem(plainTextBetween(view.state.doc, range.from, range.to, { blocks: true })),
  );
}

/**
 * The blocks chosen, copied (and cut): through the browser's own copy,
 * which a page may write to only in its copy event. WebKit has no copy
 * with nothing selected but when its beforecopy is taken; nor, from a
 * button, with the focus out of the note, which is why the copy is written
 * here and not left to the copy of a note (plain-copy.ts).
 */
export function copyChosen(editor: BlockNoteEditor, view: EditorView, cut = false) {
  const now = current(view);
  if (!now) return;
  let written = false;
  const enable = (event: Event) => event.preventDefault();
  const onCopy = (event: ClipboardEvent) => {
    written = true;
    // Written by the note's copy already (plain-copy.ts), the focus in it.
    if (event.defaultPrevented || !event.clipboardData) return;
    writeBlocks(editor, view, now.range, event.clipboardData);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("beforecopy", enable, true);
  document.addEventListener("copy", onCopy, true);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("beforecopy", enable, true);
    document.removeEventListener("copy", onCopy, true);
  }
  if (!written) {
    // No copy event at all: the text, and the blocks as HTML, by the clipboard's own way.
    const { externalHTML } = clipboardFor(editor, view, now.range);
    const text = forThisSystem(
      plainTextBetween(view.state.doc, now.range.from, now.range.to, { blocks: true }),
    );
    void navigator.clipboard
      ?.write([
        new ClipboardItem({
          "text/html": new Blob([externalHTML], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ])
      .catch(() => {});
  }
  if (cut && view.editable) removeChosen(editor, view);
}

/** Blocks chosen (null: none), the caret hidden in the first, at its start. */
export function choose(view: EditorView, chosen: Chosen | null) {
  const tr = view.state.tr.setMeta(blockSelectKey, chosen);
  if (chosen) {
    const range = chosenRange(tr.doc, chosen);
    if (!range) return;
    // Only with the focus in the note (not from the handle's menu): moved
    // with it out, ProseMirror puts the caret back there when the note is
    // next clicked, not where it is clicked.
    if (view.hasFocus()) tr.setSelection(Selection.near(tr.doc.resolve(range.from + 1)));
    tr.scrollIntoView();
  }
  view.dispatch(tr);
}

/**
 * The blocks from one to another (by their ids) chosen: from a block's
 * handle, or the phone's bar. One of those chosen already leaves them all
 * chosen, as Notion has it.
 */
export function chooseBlocks(view: EditorView, fromId: string, toId = fromId) {
  const { doc } = view.state;
  const anchor = posOf(doc, fromId);
  const head = posOf(doc, toId);
  if (anchor === null || head === null) return;
  const chosen = blockSelectKey.getState(view.state);
  const range = chosen ? chosenRange(doc, chosen) : null;
  if (fromId === toId && range && anchor >= range.from && anchor < range.to) return;
  // The caret left where it is (see choose).
  view.dispatch(view.state.tr.setMeta(blockSelectKey, { anchor, head }));
}

/** The caret to the end of the line of the block chosen last, the blocks let go. */
function editChosen(view: EditorView, chosen: Chosen) {
  const { doc } = view.state;
  const block = doc.nodeAt(chosen.head);
  const content = block?.firstChild;
  const tr = view.state.tr.setMeta(blockSelectKey, null);
  if (block?.type.name === "blockContainer" && content?.isTextblock) {
    tr.setSelection(TextSelection.create(doc, chosen.head + 1 + content.nodeSize - 1));
  }
  view.dispatch(tr.scrollIntoView());
}

/** What a box dragged from the margin starts from: a press beside the blocks, or below them, not on them. */
function inMargin(dom: HTMLElement, frame: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !frame.contains(target)) return false;
  return target === dom || target.contains(dom);
}

/** What scrolls the note: the pane on a computer's screen. */
function scrollerOf(element: Element): Element {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === "auto" || overflowY === "scroll") && at.scrollHeight > at.clientHeight) {
      return at;
    }
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * The blocks whose own line (not what is inside it) a band of the screen
 * reaches, by where each is, top to bottom: those shown only, a closed
 * toggle's hidden lines left out.
 */
function blocksAcross(view: EditorView, top: number, bottom: number): number[] {
  const found: number[] = [];
  view.dom.querySelectorAll<HTMLElement>('[data-node-type="blockContainer"]').forEach((block) => {
    const line = block.querySelector(":scope > .bn-block-content");
    if (!line) return;
    const box = line.getBoundingClientRect();
    if (box.height === 0 || box.bottom < top || box.top > bottom) return;
    const pos = view.posAtDOM(block, 0) - 1;
    if (view.state.doc.nodeAt(pos)?.type.name === "blockContainer") found.push(pos);
  });
  return found;
}

/** The caret where a click in the margin puts it: in the line beside it, as the browser does. */
function caretBeside(view: EditorView, x: number, y: number): Selection | null {
  const box = view.dom.getBoundingClientRect();
  const style = getComputedStyle(view.dom);
  const left = box.left + parseFloat(style.paddingLeft) + 1;
  const right = box.right - parseFloat(style.paddingRight) - 1;
  const at = view.posAtCoords({
    left: Math.min(right, Math.max(left, x)),
    top: Math.min(box.bottom - 2, Math.max(box.top + 2, y)),
  });
  return at ? Selection.near(view.state.doc.resolve(at.pos)) : null;
}

/** Whether a change is the document's own syncing (y-prosemirror), or added after one. */
const keeps = (tr: { getMeta(key: string): unknown }) =>
  Boolean((tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin) ||
  Boolean(tr.getMeta("appendedTransaction"));

export const blockSelect = createExtension(({ editor }) => {
  const plain = editor as unknown as BlockNoteEditor;
  // A paste of blocks Memoca copied as blocks, under way.
  let pastingBlocks = false;
  // A press in the margin, for a box (or a click) of its own: not ProseMirror's.
  let boxing = false;
  /** The view, while blocks are chosen in it. */
  const chosenIn = () => {
    const view = editor.prosemirrorView;
    return view && blockSelectKey.getState(view.state) ? view : null;
  };
  const step = (dir: "up" | "down", extend: boolean) => {
    const view = chosenIn();
    if (!view) return false;
    const next = movedChoice(
      view.state.doc,
      blockSelectKey.getState(view.state)!,
      dir,
      extend,
      shownOn(view),
    );
    // At the top or the bottom: stays as it is.
    if (next) choose(view, next);
    return true;
  };
  return {
    key: "memocaBlockSelect",
    // Before the lists', the toggles', and Shift+↑↓ over images: only while
    // blocks are chosen, but for Esc and ⌘D.
    runsBefore: ["memocaListKeys", "memocaToggles", "memocaLinesAbove", "memocaSelectMedia"],
    keyboardShortcuts: {
      Escape: ({ event }) => {
        const view = editor.prosemirrorView;
        if (!view || event.isComposing || event.keyCode === 229) return false;
        if (blockSelectKey.getState(view.state)) {
          choose(view, null);
          return true;
        }
        // Closing a menu by the caret (/, [[, :) is theirs.
        if (editor.getExtension(SuggestionMenu)?.shown()) return false;
        const chosen = chosenFrom(view.state);
        if (!chosen) return false;
        choose(view, chosen);
        return true;
      },
      ArrowUp: () => step("up", false),
      ArrowDown: () => step("down", false),
      "Shift-ArrowUp": () => step("up", true),
      "Shift-ArrowDown": () => step("down", true),
      Enter: () => {
        const view = chosenIn();
        if (!view) return false;
        editChosen(view, blockSelectKey.getState(view.state)!);
        return true;
      },
      Backspace: () => {
        const view = chosenIn();
        if (!view || !view.editable) return false;
        removeChosen(plain, view);
        return true;
      },
      Delete: () => {
        const view = chosenIn();
        if (!view || !view.editable) return false;
        removeChosen(plain, view);
        return true;
      },
      // Tab moves the caret's block alone: nothing, while more are chosen.
      Tab: () => Boolean(chosenIn()),
      "Shift-Tab": () => Boolean(chosenIn()),
      "Mod-c": () => {
        const view = chosenIn();
        if (!view) return false;
        copyChosen(plain, view);
        return true;
      },
      "Mod-x": () => {
        const view = chosenIn();
        if (!view) return false;
        copyChosen(plain, view, view.editable);
        return true;
      },
      // The blocks chosen, or the caret's, duplicated.
      "Mod-d": ({ event }) => {
        const view = editor.prosemirrorView;
        if (!view || !view.editable || event.isComposing || event.keyCode === 229) return false;
        if (!blockSelectKey.getState(view.state)) {
          const chosen = chosenFrom(view.state);
          if (!chosen) return false;
          choose(view, chosen);
        }
        duplicateChosen(plain, view);
        return true;
      },
    },
    prosemirrorPlugins: [
      new Plugin<Chosen | null>({
        key: blockSelectKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(blockSelectKey) as Chosen | null | undefined;
            if (meta !== undefined) return meta;
            if (!value) return null;
            // Let go with the caret moved, or anything written, but the
            // document's own syncing.
            if ((tr.selectionSet || tr.docChanged) && !keeps(tr)) return null;
            const anchor = tr.mapping.mapResult(value.anchor, 1);
            const head = tr.mapping.mapResult(value.head, 1);
            if (anchor.deleted || head.deleted) return null;
            return { anchor: anchor.pos, head: head.pos };
          },
        },
        props: {
          decorations(state) {
            const chosen = blockSelectKey.getState(state);
            const range = chosen ? chosenRange(state.doc, chosen) : null;
            if (!range) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              chosenBlocks(state.doc, range).map((block) =>
                Decoration.node(block.pos, block.pos + block.node.nodeSize, {
                  class: "memoca-chosen-block",
                }),
              ),
            );
          },
          // A click in the note lets the blocks go: one where the caret is
          // already (left there, chosen from a handle) does not move it,
          // which lets them go otherwise. Once ProseMirror has the caret
          // where it was clicked: a change made before would put the caret
          // back where it was.
          handleDOMEvents: {
            mousedown: () => boxing,
          },
          handleClick(view) {
            if (!blockSelectKey.getState(view.state)) return false;
            setTimeout(() => {
              if (blockSelectKey.getState(view.state)) choose(view, null);
            });
            return false;
          },
          handlePaste(view, _event, slice) {
            if (!pastingBlocks || !view.editable) return false;
            const content = wholeBlocks(slice);
            const tr = content ? placeBlocks(view.state, content) : null;
            if (!tr) return false;
            ownStep(view, () => view.dispatch(tr));
            return true;
          },
          attributes: (state): Record<string, string> =>
            blockSelectKey.getState(state) ? { class: "memoca-blocks-chosen" } : {},
        },
      }),
    ],
    mount({ dom, signal }) {
      // A box dragged from the margin: drawn over the page, the blocks its
      // band reaches chosen as it goes, the pane scrolled at its edges.
      const frame = dom.closest(".bn-container") ?? dom;
      let box: {
        x: number;
        y: number;
        scroller: Element;
        scrolled: number;
        moved: boolean;
        last: { x: number; y: number };
        overlay: HTMLElement | null;
        frame: number;
      } | null = null;
      const chosenByBox = (view: EditorView): Chosen | null => {
        if (!box) return null;
        const startY = box.y - (box.scroller.scrollTop - box.scrolled);
        const { y } = box.last;
        const blocks = blocksAcross(view, Math.min(startY, y), Math.max(startY, y));
        if (blocks.length === 0) return null;
        const [first, last] = [blocks[0]!, blocks.at(-1)!];
        return y >= startY ? { anchor: first, head: last } : { anchor: last, head: first };
      };
      const draw = () => {
        const view = editor.prosemirrorView;
        if (!box || !view) return;
        box.frame = 0;
        const edge = box.scroller.getBoundingClientRect();
        const { x, y } = box.last;
        // At the pane's edge: scrolled on, the box with it.
        if (y < edge.top + 32) box.scroller.scrollTop -= 12;
        else if (y > edge.bottom - 32) box.scroller.scrollTop += 12;
        const startY = box.y - (box.scroller.scrollTop - box.scrolled);
        const overlay = box.overlay!;
        overlay.style.left = `${Math.min(box.x, x)}px`;
        overlay.style.top = `${Math.min(startY, y)}px`;
        overlay.style.width = `${Math.abs(x - box.x)}px`;
        overlay.style.height = `${Math.abs(y - startY)}px`;
        const chosen = chosenByBox(view);
        const now = blockSelectKey.getState(view.state);
        if (JSON.stringify(chosen) !== JSON.stringify(now)) {
          view.dispatch(view.state.tr.setMeta(blockSelectKey, chosen));
        }
        if (y < edge.top + 32 || y > edge.bottom - 32) box.frame = requestAnimationFrame(draw);
      };
      frame.addEventListener(
        "mousedown",
        (event) => {
          const press = event as MouseEvent;
          const view = editor.prosemirrorView;
          boxing = false;
          if (!view || press.button !== 0 || press.shiftKey || press.detail > 1) return;
          if (!inMargin(dom, frame, press.target)) return;
          // Not the browser's selection of text, begun there.
          press.preventDefault();
          boxing = true;
          const scroller = scrollerOf(dom);
          box = {
            x: press.clientX,
            y: press.clientY,
            scroller,
            scrolled: scroller.scrollTop,
            moved: false,
            last: { x: press.clientX, y: press.clientY },
            overlay: null,
            frame: 0,
          };
        },
        { capture: true, signal },
      );
      document.addEventListener(
        "mousemove",
        (event) => {
          if (!box) return;
          box.last = { x: event.clientX, y: event.clientY };
          if (!box.moved && Math.hypot(event.clientX - box.x, event.clientY - box.y) < 5) return;
          if (!box.moved) {
            box.moved = true;
            const overlay = document.createElement("div");
            overlay.className = "memoca-block-box";
            document.body.append(overlay);
            box.overlay = overlay;
          }
          if (!box.frame) box.frame = requestAnimationFrame(draw);
        },
        { signal },
      );
      const end = (event: MouseEvent | null) => {
        const view = editor.prosemirrorView;
        const ended = box;
        box = null;
        boxing = false;
        if (!ended) return;
        if (ended.frame) cancelAnimationFrame(ended.frame);
        ended.overlay?.remove();
        if (!view || !event) return;
        view.focus();
        if (ended.moved) {
          box = { ...ended, last: { x: event.clientX, y: event.clientY } };
          const chosen = chosenByBox(view);
          box = null;
          choose(view, chosen);
          return;
        }
        // A click, not dragged: the caret beside it, as before.
        const caret = caretBeside(view, event.clientX, event.clientY);
        const tr = view.state.tr.setMeta(blockSelectKey, null);
        if (caret) tr.setSelection(caret);
        view.dispatch(tr.scrollIntoView());
      };
      document.addEventListener("mouseup", (event) => end(event), { signal });
      window.addEventListener("blur", () => end(null), { signal });
      signal.addEventListener("abort", () => end(null));

      // WebKit's Edit menu has Copy and Cut only when its beforecopy (or
      // beforecut) is taken, there being no selection to copy.
      for (const type of ["beforecopy", "beforecut"]) {
        dom.ownerDocument.addEventListener(
          type,
          (event) => {
            if (
              chosenIn() &&
              event.target instanceof globalThis.Node &&
              dom.contains(event.target)
            ) {
              event.preventDefault();
            }
          },
          { capture: true, signal },
        );
      }
      // Blocks pasted are put by placeBlocks (over the blocks chosen, too);
      // anything else pasted over blocks chosen goes in their place, as
      // into an empty line.
      dom.ownerDocument.addEventListener(
        "paste",
        (event) => {
          if (!(event.target instanceof globalThis.Node) || !dom.contains(event.target)) return;
          pastingBlocks = Boolean(event.clipboardData?.types.includes(BLOCKS_TYPE));
          setTimeout(() => {
            pastingBlocks = false;
          });
          const view = chosenIn();
          if (pastingBlocks || !view || !view.editable) return;
          const now = current(view);
          if (!now) return;
          editor.transact(() => {
            const [line] = plain.replaceBlocks(idsOf(now.blocks), [
              { type: "paragraph" },
            ]).insertedBlocks;
            if (line) plain.setTextCursorPosition(line.id, "start");
          });
        },
        { capture: true, signal },
      );
    },
  };
});
