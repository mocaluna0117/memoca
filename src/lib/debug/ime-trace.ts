"use client";

import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { isApple } from "@/lib/platform";
import { inShell } from "@/lib/quick/shell";

/**
 * A record, kept in memory, of the keys, input-method compositions and input
 * the Mac desktop app's editor sees, to find two things that happen there now
 * and then: a word committed coming out twice (in an indented item, it
 * seems), and a line that takes only one character however many are typed.
 * Besides the events, what the editor made of them: each key ProseMirror
 * handed its handlers (its own, made up from a change it read, among them)
 * and whether one took it, each transaction, and what ime-commit decided.
 * Only counts are kept of what is written: how many lines, how long the line
 * with the caret is, where in it the caret is. ⌘⌥⇧I copies it.
 *
 * Temporary: to go once those are understood.
 */

type Entry = Record<string, string | number | boolean | null>;

/** Enough for a few minutes of typing: what went wrong is copied soon after. */
const KEEP = 3000;

/** Where ime-commit's entries go while the record is kept; nowhere otherwise. */
let sink: ((entry: Entry) => void) | null = null;

/** An entry from the editor's own parts (ime-commit), when the record is kept. */
export function traceIme(entry: Entry) {
  sink?.(entry);
}

/** Where the caret is, in counts only. */
function where(): Entry {
  const blocks = document.querySelectorAll('.ProseMirror [data-node-type="blockContainer"]');
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
  return {
    blocks: blocks.length,
    at: index,
    len: own(block),
    prevLen: index > 0 ? own(blocks[index - 1]) : null,
    depth: block ? depth : null,
    inGroup: block?.parentElement?.children.length ?? null,
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

export function startImeTrace(onCopied: () => void): () => void {
  if (typeof window === "undefined" || !inShell() || !isApple(navigator.userAgent)) {
    return () => {};
  }
  const entries: Entry[] = [];
  const start = performance.now();
  const push = (entry: Entry) => {
    entries.push({ t: Math.round(performance.now() - start), ...entry });
    if (entries.length > KEEP) entries.shift();
  };
  sink = push;

  const record = (event: Event) => {
    const entry: Entry = { t: Math.round(performance.now() - start), type: event.type };
    if (event instanceof KeyboardEvent) {
      Object.assign(entry, {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        composing: event.isComposing,
      });
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
    setTimeout(() => {
      const after = where();
      entry.blocksAfter = after.blocks;
      entry.lenAfter = after.len;
      entry.atAfter = after.at;
    }, 0);
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

  type SomeProp = (name: string, f?: (prop: unknown) => unknown) => unknown;
  type Viewish = { composing: boolean; someProp: SomeProp };
  type Editorish = {
    view: Viewish;
    on(event: "transaction", handler: (props: { transaction: Transaction }) => void): void;
    off(event: "transaction", handler: (props: { transaction: Transaction }) => void): void;
  };
  let watched: Editorish | null = null;

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
            key: event.key,
            keyCode: event.keyCode,
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
  const watching = setInterval(watch, 1000);
  watch();

  const types = [
    "keydown",
    "keyup",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "beforeinput",
    "input",
  ];
  for (const type of types) document.addEventListener(type, record, true);

  const copy = (event: KeyboardEvent) => {
    if (!(event.metaKey && event.altKey && event.shiftKey && event.code === "KeyI")) return;
    event.preventDefault();
    const text = [
      `${navigator.userAgent} vendor=${navigator.vendor}`,
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n");
    void navigator.clipboard.writeText(text).then(onCopied);
  };
  window.addEventListener("keydown", copy, true);

  return () => {
    sink = null;
    clearInterval(watching);
    mutations.disconnect();
    watched?.off("transaction", onTransaction);
    unwrap();
    for (const type of types) document.removeEventListener(type, record, true);
    window.removeEventListener("keydown", copy, true);
  };
}
