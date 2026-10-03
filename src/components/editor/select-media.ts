import { createExtension } from "@blocknote/core";
import type { Node, ResolvedPos } from "prosemirror-model";
import {
  type EditorState,
  Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { isOpenOnScreen, isToggle } from "@/components/editor/toggles";

/**
 * Whether a block holds no text to put a caret in: an image, a video, an
 * audio clip or a file. (A table does, in its cells.)
 */
const isMedia = (container: Node) => {
  const content = container.firstChild;
  return !!content && !content.isTextblock && content.childCount === 0;
};

/** A block (blockContainer) and where it is. */
type Found = { node: Node; pos: number };

/** Whether the blocks inside a block are shown: all are, but a closed toggle's. */
type Shown = (block: Found) => boolean;

/** Where a block's line ends, and the group of blocks inside it (if any) starts. */
const afterLine = (block: Found) => block.pos + 1 + block.node.firstChild!.nodeSize;

/** Whether a block has blocks inside it, shown. */
const hasShownInside = (block: Found, shown: Shown) => block.node.childCount > 1 && shown(block);

/** The blockContainer a position is in (the deepest), and where it is. */
function blockAt($pos: ResolvedPos): Found | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === "blockContainer") return { node, pos: $pos.before(depth) };
  }
  return null;
}

/** The block reading after a position between blocks: the next at its level, or after the block it is in. */
function blockAfterPos(doc: Node, pos: number): Found | null {
  let $pos = doc.resolve(pos);
  for (;;) {
    const next = $pos.nodeAfter;
    if (next?.type.name === "blockContainer") return { node: next, pos: $pos.pos };
    if ($pos.depth === 0) return null;
    $pos = doc.resolve($pos.after());
  }
}

/** The block reading after a block's line: its first inside, if shown, or the next after it. */
function blockAfter(doc: Node, block: Found, shown: Shown): Found | null {
  return hasShownInside(block, shown)
    ? blockAfterPos(doc, afterLine(block) + 1)
    : blockAfterPos(doc, block.pos + block.node.nodeSize);
}

/** The block reading before a block: the one before it (its last inside, if shown), or the one it is in. */
function blockBefore(doc: Node, block: Found, shown: Shown): Found | null {
  const $pos = doc.resolve(block.pos);
  const previous = $pos.nodeBefore;
  if (previous?.type.name !== "blockContainer") {
    return $pos.depth > 1 ? blockAt(doc.resolve($pos.before())) : null;
  }
  let found: Found = { node: previous, pos: block.pos - previous.nodeSize };
  while (hasShownInside(found, shown)) {
    const group = found.node.child(1);
    const last = group.lastChild!;
    found = { node: last, pos: afterLine(found) + 1 + group.content.size - last.nodeSize };
  }
  return found;
}

/**
 * Where a selection's head goes, taken over or onto a block: past an
 * image's (inside its block, so BlockNote still finds the block it is in),
 * or before it; to the end of a line of text, or its start; into a table's
 * last cell, or its first. Null for a block with neither.
 */
function headOver(doc: Node, block: Found, dir: "down" | "up"): number | null {
  const content = block.node.firstChild!;
  if (isMedia(block.node)) return dir === "down" ? afterLine(block) : block.pos + 1;
  if (content.isTextblock) return dir === "down" ? afterLine(block) - 1 : block.pos + 2;
  // A table: to the end of the text of its last cell, or the start of its first.
  let head: number | null = null;
  doc.nodesBetween(block.pos + 1, afterLine(block), (node, pos) => {
    if (!node.isTextblock) return true;
    if (dir === "up" && head === null) head = pos + 1;
    if (dir === "down") head = pos + 1 + node.content.size;
    return false;
  });
  return head;
}

/** Each image or file a range takes whole, by where its content node is. */
function eachMedia(doc: Node, from: number, to: number, f: (pos: number, content: Node) => void) {
  doc.nodesBetween(from, to, (node, pos) => {
    // Groups, and columns and the rows of them, hold blocks: looked into.
    if (node.type.name === "blockGroup" || node.type.name === "columnList" || node.type.name === "column") {
      return true;
    }
    if (node.type.name !== "blockContainer") return false;
    const content = node.firstChild!;
    if (isMedia(node) && from <= pos + 1 && pos + 1 + content.nodeSize <= to) f(pos + 1, content);
    return true;
  });
}

/** Whether a range takes an image or a file whole. */
function hasMedia(doc: Node, from: number, to: number) {
  let found = false;
  eachMedia(doc, from, to, () => (found = true));
  return found;
}

/**
 * Shift+↓ (or ↑) where the next (or previous) block is an image or a file:
 * the selection taken over it. The browser's own moves the caret between
 * lines of text only, so an image with no text after it (at the end of a
 * note, say) could never be selected from the keyboard, nor copied with
 * the text before it. From there on, the next block is taken whole, a
 * press each. What a closed toggle hides is passed over, as the browser
 * passes over it.
 *
 * Null to leave the key to the browser (or to a table's own): not a
 * selection of text, not at the edge of the lines of a block's own line,
 * or text or a table next.
 */
export function extendOverMedia(
  state: EditorState,
  dir: "down" | "up",
  atEdge: boolean,
  shown: Shown = () => true,
): Transaction | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $head, $anchor } = selection;
  const block = blockAt($head);
  if (!block) return null;
  let next: Found | null;
  if ($head.parent.inlineContent) {
    // In the block's own line, not in a table's cell, and at its edge.
    if ($head.parent !== block.node.firstChild || !atEdge) return null;
    next = dir === "down" ? blockAfter(doc, block, shown) : blockBefore(doc, block, shown);
    if (!next || !isMedia(next.node)) return null;
  } else {
    // At an image, where a move over it left the head: over that image
    // first, back the way it came, or on to the next.
    if (!isMedia(block.node)) return null;
    const start = block.pos + 1;
    const end = afterLine(block);
    if (dir === "down" && $head.pos === start) next = block;
    else if (dir === "up" && $head.pos === end) next = block;
    else next = dir === "down" ? blockAfter(doc, block, shown) : blockBefore(doc, block, shown);
    if (!next) return null;
  }
  const head = headOver(doc, next, dir);
  if (head === null) return null;
  const from = Math.min($anchor.pos, head);
  const to = Math.max($anchor.pos, head);
  // Back over all that was taken: the caret, where it began, not a
  // selection of nothing to be seen.
  const none = doc.textBetween(from, to) === "" && !hasMedia(doc, from, to);
  const extended = none
    ? TextSelection.create(doc, $anchor.pos)
    : new TextSelection($anchor, doc.resolve(head));
  const tr = state.tr.setSelection(extended);
  // Into view by the editor where the head is in a line; at an image's
  // edge, by the image (see scrollToMedia).
  return extended.$head.parent.inlineContent ? tr.scrollIntoView() : tr;
}

/** Where each of what scrolls an element (its scrolling ancestors, and the page) is scrolled to. */
function scrolls(element: Element): [Element, number][] {
  const found: [Element, number][] = [];
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (at.scrollHeight > at.clientHeight) found.push([at, at.scrollTop]);
  }
  const page = document.scrollingElement;
  if (page && !found.some(([at]) => at === page)) found.push([page, page.scrollTop]);
  return found;
}

function restore(positions: [Element, number][]) {
  for (const [element, top] of positions) {
    if (element.scrollTop !== top) element.scrollTop = top;
  }
}

/** How long the browser is given to bring a selection into view. */
const HOLD_MS = 400;

/**
 * Keeps what scrolls an element where it is for a moment: put back each
 * time it moves, but not once the person scrolls or presses a key.
 */
function holdScroll(element: Element) {
  const held = scrolls(element);
  const stop = new AbortController();
  const options = { capture: true, passive: true, signal: stop.signal };
  document.addEventListener("scroll", () => restore(held), options);
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    window.addEventListener(type, () => stop.abort(), options);
  }
  setTimeout(() => stop.abort(), HOLD_MS);
}

/**
 * The image (or file) a selection's head is at the edge of, scrolled into
 * view as little as it takes. ProseMirror (and the browser) find no good
 * place on the screen for a head between blocks: in an open toggle they
 * took the toggle's foot, and Shift+↓ threw the note down to there.
 */
function scrollToMedia(view: EditorView) {
  const block = blockAt(view.state.selection.$head);
  if (!block || !isMedia(block.node)) return;
  const element = view.nodeDOM(block.pos);
  if (element instanceof HTMLElement) element.scrollIntoView({ block: "nearest" });
}

/**
 * The images and files a selection of text runs over, marked as selected:
 * the browser shows its selection on text only.
 */
function mediaSelected(state: EditorState): DecorationSet {
  const { selection, doc } = state;
  if (selection.empty || !(selection instanceof TextSelection)) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  eachMedia(doc, selection.from, selection.to, (pos, content) =>
    decorations.push(
      Decoration.node(pos, pos + content.nodeSize, { class: "memoca-selected-media" }),
    ),
  );
  return DecorationSet.create(doc, decorations);
}

/** Whether a block's inside is on the screen: not a closed toggle's. */
const shownOn =
  (view: EditorView): Shown =>
  (block) =>
    !isToggle(block.node.firstChild) || isOpenOnScreen(view, block);

/** Shift+↓ or ↑, over an image or a file where there is one. */
function extend(view: EditorView | undefined, dir: "down" | "up") {
  if (!view) return false;
  const tr = extendOverMedia(view.state, dir, view.endOfTextblock(dir), shownOn(view));
  if (tr) {
    if (tr.scrolledIntoView) {
      view.dispatch(tr);
      return true;
    }
    // The browser brings a selection's head into view itself, once the
    // selection has changed. Between blocks it can put no caret there, so it
    // looks on for where it could, past the images (in an open toggle, to
    // its foot) and the note was thrown down to there. The image is brought
    // into view instead, and the note held there while the browser would.
    view.dispatch(tr);
    scrollToMedia(view);
    holdScroll(view.dom);
    return true;
  }
  // At an image, with nothing further that way: kept as it is, where the
  // browser, with no text there to move over, would lose it.
  const { selection } = view.state;
  return (
    selection instanceof TextSelection &&
    !selection.$head.parent.inlineContent &&
    isMedia(blockAt(selection.$head)?.node ?? view.state.doc)
  );
}

/** A selection ending at an image let go of, the caret (or the image) near where it ended. */
function collapse(view: EditorView | undefined, bias: 1 | -1) {
  const selection = view?.state.selection;
  if (!view || !selection || !endsAtMedia(selection)) return false;
  view.dispatch(view.state.tr.setSelection(Selection.near(selection.$head, bias)).scrollIntoView());
  return true;
}

/**
 * Enter over a selection that ends at an image: what is selected taken
 * out first, which BlockNote's Enter, splitting a line, does not expect.
 * Left to it then (false), to go on to a new line.
 */
function enterOverMedia(view: EditorView | undefined) {
  if (!view || !endsAtMedia(view.state.selection)) return false;
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  return false;
}

/**
 * A selection of all the note's text (⌘A, or a drag from its first
 * letter to its last) taken on to the images and files before the first
 * line of text or after the last: the browser's own select-all ends in
 * text, so an image at the end of a note was left out of it.
 */
export function selectAllOfIt(state: EditorState): Transaction | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  let first = -1;
  let last = -1;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (first < 0) first = pos + 1;
    last = pos + 1 + node.content.size;
    return false;
  });
  if (selection.from !== first || selection.to !== last) return null;
  const group = doc.firstChild!;
  const top = { node: group.firstChild!, pos: 1 };
  const bottom = {
    node: group.lastChild!,
    pos: group.content.size + 1 - group.lastChild!.nodeSize,
  };
  const from = isMedia(top.node) ? top.pos + 1 : first;
  const to = isMedia(bottom.node) ? afterLine(bottom) : last;
  if (from === first && to === last) return null;
  return state.tr.setSelection(new TextSelection(doc.resolve(from), doc.resolve(to)));
}

/**
 * A selection made by dragging, let go of over an image (or past the last
 * block, an image, or before the first): taken on over that image, from
 * where the drag began. The browser ends a drag's selection in text only,
 * so an image at the end of a note could not be dragged over, and one let
 * go of on lost the selection.
 */
export function dragOntoMedia(
  state: EditorState,
  anchor: number,
  media: Found,
): Transaction | null {
  if (!isMedia(media.node)) return null;
  const head = anchor <= media.pos ? afterLine(media) : media.pos + 1;
  if (head === anchor) return null;
  const { doc } = state;
  return state.tr.setSelection(new TextSelection(doc.resolve(anchor), doc.resolve(head)));
}

/** The image a drag was let go of over, or past (the note's last block) or before (its first). */
function mediaAtPointer(view: EditorView, x: number, y: number): Found | null {
  const group = view.state.doc.firstChild!;
  const edge = (node: Node, pos: number, rect: DOMRect | undefined, past: boolean) =>
    rect && (past ? y > rect.bottom : y < rect.top) && isMedia(node) ? { node, pos } : null;
  const last = group.lastChild!;
  const lastPos = group.content.size + 1 - last.nodeSize;
  const lastRect = (view.nodeDOM(lastPos) as HTMLElement | null)?.getBoundingClientRect();
  const firstRect = (view.nodeDOM(1) as HTMLElement | null)?.getBoundingClientRect();
  const beside =
    edge(last, lastPos, lastRect, true) ?? edge(group.firstChild!, 1, firstRect, false);
  if (beside) return beside;
  const element = view.root.elementFromPoint?.(x, y);
  const content =
    element && view.dom.contains(element) ? element.closest(".bn-block-content") : null;
  if (!content) return null;
  try {
    const block = blockAt(view.state.doc.resolve(view.posAtDOM(content, 0)));
    return block && isMedia(block.node) ? block : null;
  } catch {
    return null;
  }
}

/** Whether a selection ends (or starts) at an image, not in a line of text. */
const endsAtMedia = (selection: Selection) =>
  selection instanceof TextSelection &&
  !selection.empty &&
  (!selection.$from.parent.inlineContent || !selection.$to.parent.inlineContent);

/**
 * Images and files, taken into a selection from the keyboard (Shift+↓ or
 * ↑, or ⌘A) as text around them is, and shown as selected when they are:
 * see {@link extendOverMedia}.
 */
export const selectMedia = createExtension(({ editor }) => ({
  key: "memocaSelectMedia",
  mount({ dom, root, signal }) {
    // A drag of the mouse to select, from where it began: not a click, and
    // not one that began on an image (which drags the image).
    let down: { x: number; y: number; anchor: number } | null = null;
    dom.addEventListener(
      "mousedown",
      (event) => {
        const view = editor.prosemirrorView;
        const target = event.target instanceof Element ? event.target : null;
        const block = target?.closest(".bn-block-content");
        const onImage =
          !!block?.querySelector("img, video, audio") && !target?.closest(".bn-inline-content");
        const at = view?.posAtCoords({ left: event.clientX, top: event.clientY });
        down =
          event.button === 0 && !event.shiftKey && !onImage && at
            ? { x: event.clientX, y: event.clientY, anchor: at.pos }
            : null;
      },
      { signal },
    );
    // A drag of what is selected, to move it, ends with no mouseup.
    dom.addEventListener("dragstart", () => (down = null), { signal });
    root.addEventListener(
      "mouseup",
      (event) => {
        const start = down;
        down = null;
        const view = editor.prosemirrorView;
        if (!start || !view) return;
        const { clientX: x, clientY: y } = event as MouseEvent;
        if (Math.hypot(x - start.x, y - start.y) < 4) return;
        // Once ProseMirror has taken the selection the drag made.
        setTimeout(() => {
          if (signal.aborted) return;
          const media = mediaAtPointer(view, x, y);
          if (!media) return;
          const { selection } = view.state;
          const anchor = selection instanceof TextSelection ? selection.anchor : start.anchor;
          const tr = dragOntoMedia(view.state, anchor, media);
          if (tr) view.dispatch(tr);
        });
      },
      { signal },
    );
  },
  keyboardShortcuts: {
    "Shift-ArrowDown": () => extend(editor.prosemirrorView, "down"),
    "Shift-ArrowUp": () => extend(editor.prosemirrorView, "up"),
    Enter: () => enterOverMedia(editor.prosemirrorView),
    // Without Shift, a selection ending at an image lets go, as it does
    // ending in text: the browser has no text there to move the caret to.
    ArrowDown: () => collapse(editor.prosemirrorView, 1),
    End: () => collapse(editor.prosemirrorView, 1),
  },
  prosemirrorPlugins: [
    new Plugin({
      appendTransaction: (transactions, _before, after) =>
        transactions.some((tr) => tr.selectionSet) ? selectAllOfIt(after) : null,
      props: {
        decorations: mediaSelected,
        handleDOMEvents: {
          // Typed over with an input method, the browser changes the text it
          // can see and ProseMirror takes that: an image selected with it
          // would stay. Taken out first, as typing over it without one does.
          compositionstart: (view) => {
            if (endsAtMedia(view.state.selection)) {
              view.dispatch(view.state.tr.deleteSelection());
            }
            return false;
          },
        },
      },
    }),
  ],
}));
