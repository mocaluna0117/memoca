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
      if (to && to.node.type.name === "blockContainer") {
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
    tr.setSelection(Selection.near(tr.doc.resolve(range.from + 1)));
    tr.scrollIntoView();
  }
  view.dispatch(tr);
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

/** Whether a change is the document's own syncing (y-prosemirror), or added after one. */
const keeps = (tr: { getMeta(key: string): unknown }) =>
  Boolean((tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin) ||
  Boolean(tr.getMeta("appendedTransaction"));

export const blockSelect = createExtension(({ editor }) => {
  const plain = editor as unknown as BlockNoteEditor;
  // A paste of blocks Memoca copied as blocks, under way.
  let pastingBlocks = false;
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
