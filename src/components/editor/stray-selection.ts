import { createExtension } from "@blocknote/core";
import { Plugin, Selection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { traceIme } from "@/lib/debug/ime-trace";

/**
 * What the person last did with the pointer and the keys, for each page:
 * when, by performance.now(). A press, a move with a button down, a let go
 * or a click is the pointer's; a key that writes or acts (Enter,
 * Backspace…) or a word begun is typing; Shift with a key that moves the
 * caret (or ⌘A) is a selection made with the keys.
 */
export type Doings = {
  pointerAt: number;
  typedAt: number;
  selectKeyAt: number;
  /** The last press, and whether its let go came, the page in use as it came, and the buttons the last move had. */
  downAt: number;
  upAt: number;
  downFocused: boolean | null;
  moveButtons: number | null;
  moveAt: number;
  /** The press whose autoscroll was stopped (its downAt): once a press. */
  stoppedFor: number;
};

const doingsOf = new WeakMap<Document, Doings>();

/** Keys that, with Shift, select: the caret's own moves. */
const MOVES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const MODIFIERS = new Set(["Shift", "Meta", "Alt", "Control", "CapsLock", "Fn"]);

/** Shift with a move (a Mac's ⌃⇧A/E/F/B/N/P too), or ⌘A (Ctrl+A): a selection the person made with the keys. */
const selectsWithKeys = (event: KeyboardEvent) =>
  (event.shiftKey && MOVES.has(event.key)) ||
  (event.shiftKey && event.ctrlKey && /^[aefbnp]$/i.test(event.key)) ||
  ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a");

/** What the person did on this page, watched from the first editor on it for as long as the page is there. */
function watch(doc: Document): Doings {
  const known = doingsOf.get(doc);
  if (known) return known;
  const doings: Doings = {
    pointerAt: 0,
    typedAt: 0,
    selectKeyAt: 0,
    downAt: 0,
    upAt: 0,
    downFocused: null,
    moveButtons: null,
    moveAt: 0,
    stoppedFor: -1,
  };
  doingsOf.set(doc, doings);
  const options = { capture: true, passive: true } as const;
  const pointer = (event: Event) => {
    const now = performance.now();
    doings.pointerAt = now;
    if (event.type === "pointerdown") {
      doings.downAt = now;
      doings.downFocused = doc.hasFocus();
    } else if (event.type === "pointerup" || event.type === "pointercancel") {
      doings.upAt = now;
    }
  };
  for (const type of ["pointerdown", "pointerup", "pointercancel", "click", "dblclick", "contextmenu"]) {
    doc.addEventListener(type, pointer, options);
  }
  doc.addEventListener(
    "pointermove",
    (event) => {
      const { buttons } = event as MouseEvent;
      doings.moveButtons = buttons;
      doings.moveAt = performance.now();
      // A drag: the selection it makes is the person's.
      if (buttons !== 0) doings.pointerAt = doings.moveAt;
    },
    options,
  );
  // On the window, as it captures: first of all, whatever stops the key later.
  doc.defaultView?.addEventListener(
    "keydown",
    (event) => {
      if (MODIFIERS.has(event.key)) return;
      if (selectsWithKeys(event)) doings.selectKeyAt = performance.now();
      else doings.typedAt = performance.now();
    },
    options,
  );
  for (const type of ["beforeinput", "compositionstart"]) {
    doc.defaultView?.addEventListener(
      type,
      () => {
        doings.typedAt = performance.now();
      },
      options,
    );
  }
  return doings;
}

/** WebKit on a computer: the Mac desktop app and Safari, not an iPhone's or iPad's (touch). */
function onHere(): boolean {
  if (typeof navigator === "undefined" || !/Apple/.test(navigator.vendor)) return false;
  return !(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
}

/**
 * The page's selection, when it is a range the person did not make, over
 * the editor's caret: where it reaches, before and after the caret. Null
 * when it is anything else.
 *
 * WebKit, holding a press it never saw let go of, after the pointer moved
 * a little while pressed, takes the selection on to the place under the
 * pointer every 50 ms, from wherever the caret has gone (its selection
 * autoscroll, in a pane that scrolls). In the quick note's Todo, Enter's
 * new item was then selected back to the item above, under the pointer,
 * and the first character typed joined the two; and each character typed
 * after was selected back to the pointer, and the next took its place.
 *
 * A range the editor made (⌘A, a match found, an image) is the editor's
 * selection already; one made by the pointer, or by Shift with a key that
 * moves the caret, comes after that, not after typing; and a word being
 * written is the input method's.
 */
export function strayRange(view: EditorView, doings: Doings): { back: number; forward: number } | null {
  if (!onHere() || view.composing || !view.hasFocus()) return null;
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  if (doings.typedAt <= Math.max(doings.pointerAt, doings.selectKeyAt)) return null;
  const page = view.dom.ownerDocument.getSelection();
  if (!page || page.isCollapsed || !page.anchorNode || !page.focusNode) return null;
  if (!view.dom.contains(page.anchorNode) || !view.dom.contains(page.focusNode)) return null;
  let from: number;
  let to: number;
  try {
    const anchor = view.posAtDOM(page.anchorNode, page.anchorOffset, 1);
    const head = view.posAtDOM(page.focusNode, page.focusOffset, 1);
    // An end between blocks (by a tick box, a due's button) taken out to
    // the nearest place in text: its start back, its end on.
    const out = (pos: number, dir: 1 | -1) => {
      const $pos = doc.resolve(pos);
      if ($pos.parent.inlineContent) return pos;
      const found = Selection.findFrom($pos, dir, true);
      return found ? (dir > 0 ? found.from : found.to) : pos;
    };
    from = out(Math.min(anchor, head), -1);
    to = out(Math.max(anchor, head), 1);
  } catch {
    return null;
  }
  const caret = selection.head;
  if (from >= to || caret < from || caret > to) return null;
  // Every line: the Edit menu's Select All, with nothing of the pointer's or the keys'.
  if (from <= Selection.atStart(doc).from && to >= Selection.atEnd(doc).to) return null;
  return { back: caret - from, forward: to - caret };
}

/**
 * A box's display, and another that has WebKit build the box again, laid
 * out as it was: the one put on and taken off at once, before anything is
 * drawn.
 */
const OTHER_DISPLAY: Record<string, string> = {
  block: "flow-root",
  "flow-root": "block",
  flex: "inline-flex",
  "inline-flex": "flex",
  grid: "inline-grid",
  "inline-grid": "grid",
};

const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll" || overflow === "overlay";

/** The boxes that scroll, from this node out, short of the page itself. */
function scrollersFrom(node: globalThis.Node | null, found: Set<HTMLElement>): void {
  const doc = node?.ownerDocument;
  let box = node instanceof Element ? node : (node?.parentElement ?? null);
  for (; box && box !== doc?.body && box !== doc?.documentElement; box = box.parentElement) {
    if (!(box instanceof HTMLElement)) continue;
    const style = getComputedStyle(box);
    if (
      (scrolls(style.overflowY) && box.scrollHeight > box.clientHeight) ||
      (scrolls(style.overflowX) && box.scrollWidth > box.clientWidth)
    ) {
      found.add(box);
    }
  }
}

/**
 * WebKit's selection autoscroll stopped: the box it scrolls (one that
 * scrolls around these nodes) built again, which stops it, where it was
 * scrolled to kept. How many were.
 *
 * Only put back (see {@link strayRange}), the selection was taken on again
 * every 50 ms for as long as the press was held, which ends a word being
 * written with the input method, as WebKit ends one whose selection moves.
 */
function stopAutoscroll(nodes: (globalThis.Node | null)[]): number {
  const boxes = new Set<HTMLElement>();
  for (const node of nodes) scrollersFrom(node, boxes);
  let stopped = 0;
  for (const box of boxes) {
    const other = OTHER_DISPLAY[getComputedStyle(box).display];
    if (!other) continue;
    const { scrollTop, scrollLeft } = box;
    const own = box.style.display;
    box.style.display = other;
    void box.offsetHeight;
    box.style.display = own;
    void box.offsetHeight;
    box.scrollTop = scrollTop;
    box.scrollLeft = scrollLeft;
    stopped += 1;
  }
  return stopped;
}

/** What held the press, for the record: whether its let go came, how long ago, the page in use as it came, the last move's buttons. */
function pressNote(doings: Doings) {
  const now = performance.now();
  return {
    sinceDown: doings.downAt ? Math.round(now - doings.downAt) : null,
    upSeen: doings.upAt >= doings.downAt && doings.downAt > 0,
    downFocused: doings.downFocused,
    moveButtons: doings.moveButtons,
    sinceMove: doings.moveAt ? Math.round(now - doings.moveAt) : null,
  };
}

/**
 * The page's selection put back to the editor's caret, as WebKit takes it
 * on from a press it never saw let go of (see {@link strayRange}): as it
 * changes, before the editor reads it, and again as a key comes or a word
 * begins, before either takes it; and the autoscroll that takes it on
 * stopped (see stopAutoscroll). Typing then goes on at the caret; the
 * press ends with the next click.
 */
export const straySelection = createExtension(({ editor }) => {
  /** The typing the last entry in the record was for: one entry each time they type, not one each 50 ms. */
  let loggedFor = -1;
  const putBack = (view: EditorView, at: string): boolean => {
    const doings = watch(view.dom.ownerDocument);
    const stray = strayRange(view, doings);
    if (!stray) return false;
    const page = view.dom.ownerDocument.getSelection()!;
    const ends = [page.anchorNode, page.focusNode, view.dom];
    const caret = view.domAtPos(view.state.selection.head);
    page.collapse(caret.node, caret.offset);
    // And the autoscroll that took it on stopped, once a press.
    let stopped: number | null = null;
    if (doings.stoppedFor !== doings.downAt) {
      doings.stoppedFor = doings.downAt;
      stopped = stopAutoscroll(ends);
    }
    if (loggedFor !== doings.typedAt) {
      loggedFor = doings.typedAt;
      traceIme({ type: "stray-range", at, ...stray, stopped, ...pressNote(doings) });
    }
    return true;
  };
  /**
   * Typing begun with a press not let go of, as far as the page was told:
   * its autoscroll stopped at once, before it takes the selection on (and
   * ends the word being written, with the input method).
   */
  const heldOn = (view: EditorView, at: string): void => {
    const doings = watch(view.dom.ownerDocument);
    if (!onHere() || doings.downAt <= doings.upAt || doings.stoppedFor === doings.downAt) return;
    doings.stoppedFor = doings.downAt;
    traceIme({ type: "stuck-press", at, stopped: stopAutoscroll([view.dom]), ...pressNote(doings) });
  };
  return {
    key: "memocaStraySelection",
    prosemirrorPlugins: [
      new Plugin({
        props: {
          handleDOMEvents: {
            // Before ProseMirror's own, which deletes a range a word begins over.
            compositionstart: (view) => {
              putBack(view, "compositionstart");
              heldOn(view, "compositionstart");
              return false;
            },
          },
        },
      }),
    ],
    mount({ dom, signal }) {
      if (!onHere()) return;
      const doc = dom.ownerDocument;
      const win = doc.defaultView;
      if (!win) return;
      watch(doc);
      const view = () => editor.prosemirrorView;
      // On the window, as it captures: before ProseMirror's own, on the page.
      win.addEventListener(
        "selectionchange",
        () => {
          const current = view();
          if (current) putBack(current, "selectionchange");
        },
        { capture: true, signal },
      );
      // Before the key reaches the editor, or the page writes it.
      doc.addEventListener(
        "keydown",
        (event) => {
          const current = view();
          if (current && event.target instanceof globalThis.Node && current.dom.contains(event.target)) {
            putBack(current, "keydown");
            if (!MODIFIERS.has(event.key)) heldOn(current, "keydown");
          }
        },
        { capture: true, signal },
      );
    },
  };
});
