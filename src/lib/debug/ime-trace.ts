"use client";

import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { isApple } from "@/lib/platform";
import { SHELL_HIDDEN, inShell } from "@/lib/quick/shell";

/**
 * A record, kept in memory, of the keys, input-method compositions and input
 * the Mac desktop app's editor sees, to find two things that happen there now
 * and then: a word committed coming out twice (in an indented item, it
 * seems), and a line that takes only one character however many are typed.
 * Besides the events, what the editor made of them: each key ProseMirror
 * handed its handlers (its own, made up from a change it read, among them)
 * and whether one took it, each transaction, and what ime-commit decided.
 * Only counts are kept of what is written: how many lines, how long the line
 * with the caret is, where in it the caret is.
 *
 * In the quick note's window too, whose field is a plain one: there, now and
 * then, each character typed took the place of the one after the caret, and
 * none could be deleted, until the window was put away and brought out
 * again. Of a plain field, how long its text is, where its selection is, and
 * whether it is read-only; and when the window or the field had the focus.
 *
 * Kept only when asked for: ⌘⌥⇧I starts the record, and pressed again copies
 * it and stops it; with localStorage's memoca:ime-trace set to 1 it is kept
 * from the page's load. Until it is asked for, nothing of this runs on a key
 * but the one listener for ⌘⌥⇧I.
 *
 * Temporary: to go once those are understood.
 */

type Entry = Record<string, string | number | boolean | null>;

/** Enough for a few minutes of typing: what went wrong is copied soon after. */
const KEEP = 3000;

/** What, set to 1 in localStorage, keeps the record from the page's load. */
const FROM_LOAD = "memoca:ime-trace";

/** Where ime-commit's entries go while the record is kept; nowhere otherwise. */
let sink: ((entry: Entry) => void) | null = null;

/** An entry from the editor's own parts (ime-commit), when the record is kept. */
export function traceIme(entry: Entry) {
  sink?.(entry);
}

type SomeProp = (name: string, f?: (prop: unknown) => unknown) => unknown;
/** As much of ProseMirror's view as is read; `dom` is the editor's element. */
type Viewish = { composing: boolean; someProp: SomeProp; dom?: Element };
type Editorish = {
  view: Viewish;
  on(event: "transaction", handler: (props: { transaction: Transaction }) => void): void;
  off(event: "transaction", handler: (props: { transaction: Transaction }) => void): void;
};
/** The editor whose doings are recorded: while the record is kept, and there is one. */
let watched: Editorish | null = null;
/** Its element on the page: the editor's own view may be gone before the next look. */
let watchedDom: Element | null = null;

/** A plain field (the quick note's, a title), when that is what has the focus. */
const plainField = (node: Element | null) =>
  node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? node : null;

/** Where the caret is, in counts only: looked for in the editor, not the whole page. */
function where(): Entry {
  // In the editor recorded, while its element is on the page; else wherever one is.
  const blocks = watchedDom?.isConnected
    ? watchedDom.querySelectorAll('[data-node-type="blockContainer"]')
    : document.querySelectorAll('.ProseMirror [data-node-type="blockContainer"]');
  const anchor = document.getSelection()?.anchorNode ?? null;
  const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  const block = element?.closest('[data-node-type="blockContainer"]') ?? null;
  const index = block ? Array.prototype.indexOf.call(blocks, block) : -1;
  const own = (container: Element | null | undefined) =>
    container?.querySelector(":scope > .bn-block-content")?.textContent?.length ?? null;
  // How deep the line is (1 at the top), and how many lines its group has.
  let depth = 0;
  for (let up = block?.parentElement; up && !up.classList.contains("ProseMirror");) {
    if (up.classList.contains("bn-block-group")) depth++;
    up = up.parentElement;
  }
  // A plain field with the focus (the quick note's, a title): its counts.
  const plain = plainField(document.activeElement);
  return {
    blocks: blocks.length,
    at: index,
    len: own(block),
    prevLen: index > 0 ? own(blocks[index - 1]) : null,
    depth: block ? depth : null,
    // Its group's lines: its own parent is BlockNote's outer wrapper, it alone in it.
    inGroup: block?.closest(".bn-block-group")?.children.length ?? null,
    fieldLen: plain ? plain.value.length : null,
    selStart: plain ? plain.selectionStart : null,
    selEnd: plain ? plain.selectionEnd : null,
    readOnly: plain ? plain.readOnly : null,
  };
}

/** How many lines (blockContainers) a transaction's steps put in. */
function linesPut(transaction: Transaction): number {
  let count = 0;
  for (const step of transaction.steps) {
    const slice = (step as { slice?: { content: { descendants(f: (node: Node) => void): void } } })
      .slice;
    slice?.content.descendants((node) => {
      if (node.type.name === "blockContainer") count++;
    });
  }
  return count;
}

/**
 * A key as the record keeps it: one with a name (Enter, Backspace, Tab,
 * Process, Shift…) by its name; one that writes a character, only that it
 * was one, as its key, code or key code would tell what was written. Its key
 * code is kept when it is 229, the input method's.
 */
function keyOf(event: KeyboardEvent): Entry {
  const named = /^[A-Z][A-Za-z0-9]+$/.test(event.key);
  return {
    key: named ? event.key : "char",
    code: named ? event.code : null,
    keyCode: named || event.keyCode === 229 ? event.keyCode : null,
  };
}

/** Where a transaction leaves the caret, in counts only. */
function caretAfter(transaction: Transaction): Entry {
  const { selection } = transaction;
  const { $from } = selection;
  const inLine = $from.parent.isTextblock;
  return {
    selEmpty: selection.empty,
    // "text", "node" or "all": its class name is minified away.
    selKind: (selection.toJSON() as { type?: string }).type ?? null,
    off: inLine ? $from.parentOffset : null,
    lineLen: inLine ? $from.parent.content.size : null,
    pmDepth: $from.depth,
    // Its line's place in its group, and how many the group has.
    index: $from.depth >= 2 ? $from.index($from.depth - 2) : null,
    of: $from.depth >= 2 ? $from.node($from.depth - 2).childCount : null,
  };
}

/**
 * Listens for ⌘⌥⇧I, which starts the record (`onStarted`) and, pressed
 * again, copies it and stops it (`onCopied`). Nothing else is listened for
 * until it is pressed, unless the record is to be kept from the load.
 */
export function startImeTrace({
  onStarted,
  onCopied,
}: {
  onStarted: () => void;
  onCopied: () => void;
}): () => void {
  if (typeof window === "undefined" || !inShell() || !isApple(navigator.userAgent)) {
    return () => {};
  }
  let recording = false;
  let entries: Entry[] = [];
  let start = 0;
  const push = (entry: Entry) => {
    entries.push({ t: Math.round(performance.now() - start), ...entry });
    if (entries.length > KEEP) entries.shift();
  };

  /** A node as a short name: its tag, and the first of its classes or its node type. */
  const short = (node: globalThis.Node | null): string => {
    if (!node) return "-";
    if (node.nodeType === globalThis.Node.TEXT_NODE) return "#text";
    const element = node as Element;
    const kind =
      element.getAttribute?.("data-node-type") ?? element.getAttribute?.("data-content-type");
    const cls = element.classList?.[0];
    return `${element.nodeName.toLowerCase()}${kind ? `[${kind}]` : cls ? `.${cls}` : ""}`;
  };

  const record = (event: Event) => {
    // The caret moving in the editor is in its transactions already: of the
    // selection, a plain field's alone, which the overwriting is about.
    if (event.type === "selectionchange" && !plainField(document.activeElement)) return;
    const entry: Entry = {
      t: Math.round(performance.now() - start),
      type: event.type,
      // Where it went: keys meant for the note can go to the title, or to
      // nothing that takes them.
      target: short(event.target as globalThis.Node | null),
      inEditor: Boolean(document.activeElement?.closest(".ProseMirror")),
    };
    if (event instanceof KeyboardEvent) {
      Object.assign(entry, keyOf(event), { composing: event.isComposing });
    } else if (event instanceof InputEvent) {
      Object.assign(entry, {
        inputType: event.inputType,
        dataLen: event.data?.length ?? null,
        composing: event.isComposing,
        cancelable: event.cancelable,
      });
    } else if (event instanceof CompositionEvent) {
      entry.dataLen = event.data?.length ?? null;
    }
    Object.assign(entry, where());
    entry.pmComposing = watched?.view.composing ?? null;
    entries.push(entry);
    if (entries.length > KEEP) entries.shift();
    // What the page made of it, once every handler has run.
    queueMicrotask(() => {
      entry.prevented = event.defaultPrevented;
    });
    // What a plain field made of it: the editor's doings are in its
    // transactions, so the page is not gone over again for them.
    setTimeout(() => {
      const plain = plainField(document.activeElement);
      if (!plain) return;
      entry.fieldLenAfter = plain.value.length;
      entry.selStartAfter = plain.selectionStart;
      entry.selEndAfter = plain.selectionEnd;
    }, 0);
  };

  // What changed in the editor's DOM, by kind of node only.
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      push({
        type: `dom:${record.type}`,
        target: short(record.target),
        parent: short(record.target.parentNode),
        added: Array.from(record.addedNodes, short).join(",") || null,
        removed: Array.from(record.removedNodes, short).join(",") || null,
      });
    }
  });

  // What the editor itself did: each transaction's steps, by kind and size,
  // whether it came from the Yjs document, and where it left the caret.
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    const sync = transaction.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined;
    push({
      type: "pm:transaction",
      composing: watched?.view.composing ?? null,
      composition: (transaction.getMeta("composition") as number | undefined) ?? null,
      sync: Boolean(sync?.isChangeOrigin),
      lines: linesPut(transaction),
      steps: transaction.steps
        .map((step) => {
          const json = step.toJSON() as {
            stepType?: string;
            from?: number;
            to?: number;
            slice?: { content?: unknown[]; openStart?: number; openEnd?: number };
          };
          const nodes = (json.slice?.content ?? []).length;
          return `${json.stepType}:${json.from}-${json.to}+${nodes}(${json.slice?.openStart ?? 0},${json.slice?.openEnd ?? 0})`;
        })
        .join(" "),
      ...caretAfter(transaction),
    });
  };

  // Each key handed to the editor's handlers, and each text ProseMirror read
  // from the page: whether one of them took it. A key ProseMirror made up
  // itself, from a change in the page that looked like Enter or Backspace,
  // is not trusted. Read through the view's someProp, which hands them out.
  let unwrap = () => {};
  const wrap = (view: Viewish) => {
    const own = view.someProp;
    view.someProp = function (this: Viewish, name, f) {
      if (!f || (name !== "handleKeyDown" && name !== "handleTextInput")) {
        return own.call(this, name, f);
      }
      let args: unknown[] | null = null;
      const handled = own.call(this, name, (prop) =>
        f((...given: unknown[]) => {
          args ??= given;
          return (prop as (...given: unknown[]) => unknown)(...given);
        }),
      );
      if (args) {
        const composing = view.composing;
        if (name === "handleKeyDown") {
          const event = (args as unknown[])[1] as KeyboardEvent;
          push({
            type: "pm:key",
            ...keyOf(event),
            trusted: event.isTrusted,
            composing,
            handled: Boolean(handled),
          });
        } else {
          const text = (args as unknown[])[3] as string;
          push({ type: "pm:text", dataLen: text.length, composing, handled: Boolean(handled) });
        }
      }
      return handled;
    };
    unwrap = () => {
      view.someProp = own;
    };
  };

  const watch = () => {
    const dom = document.querySelector(".ProseMirror") as (Element & { editor?: Editorish }) | null;
    const editor = dom?.editor ?? null;
    if (editor === watched) return;
    watched?.off("transaction", onTransaction);
    unwrap();
    unwrap = () => {};
    mutations.disconnect();
    watched = editor;
    watchedDom = dom && editor ? dom : null;
    if (!dom || !editor) return;
    editor.on("transaction", onTransaction);
    wrap(editor.view);
    mutations.observe(dom, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-is-empty-and-focused", "data-placeholder"],
    });
  };
  let watching: ReturnType<typeof setInterval> | null = null;

  const types = [
    "keydown",
    "keyup",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "beforeinput",
    "input",
    "focusin",
    "focusout",
    "selectionchange",
  ];
  // The window's own: put away and brought out by the desktop shell.
  const windowTypes = ["focus", "blur", SHELL_HIDDEN];
  const onWindow = (event: Event) => {
    if (event.target === window) push({ type: `window:${event.type}`, ...where() });
  };

  /** Starts the record, afresh. */
  const begin = () => {
    if (recording) return;
    recording = true;
    entries = [];
    start = performance.now();
    sink = push;
    for (const type of types) document.addEventListener(type, record, true);
    for (const type of windowTypes) window.addEventListener(type, onWindow, true);
    watching = setInterval(watch, 1000);
    watch();
  };
  /** Stops it: nothing listened for, and the editor left as it was. */
  const end = () => {
    if (!recording) return;
    recording = false;
    sink = null;
    if (watching !== null) clearInterval(watching);
    watching = null;
    mutations.disconnect();
    watched?.off("transaction", onTransaction);
    unwrap();
    unwrap = () => {};
    watched = null;
    watchedDom = null;
    for (const type of types) document.removeEventListener(type, record, true);
    for (const type of windowTypes) window.removeEventListener(type, onWindow, true);
  };

  // ⌘⌥⇧I starts the record; kept already, it is copied, and stopped once
  // the clipboard has it (refused the record goes on, to be copied again).
  const toggle = (event: KeyboardEvent) => {
    if (!(event.metaKey && event.altKey && event.shiftKey && event.code === "KeyI")) return;
    event.preventDefault();
    if (!recording) {
      begin();
      onStarted();
      return;
    }
    const text = [
      `${navigator.userAgent} vendor=${navigator.vendor}`,
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n");
    void navigator.clipboard.writeText(text).then(
      () => {
        end();
        onCopied();
      },
      (error: unknown) => console.error("Memoca: the input record could not be copied", error),
    );
  };
  window.addEventListener("keydown", toggle, true);

  let fromLoad = false;
  try {
    fromLoad = localStorage.getItem(FROM_LOAD) === "1";
  } catch {
    // No storage to ask: only ⌘⌥⇧I starts it, then.
  }
  if (fromLoad) begin();

  return () => {
    end();
    window.removeEventListener("keydown", toggle, true);
  };
}
