"use client";

import { isApple } from "@/lib/platform";
import { inShell } from "@/lib/quick/shell";

/**
 * A short-lived record of the keys, input-method compositions and input the
 * Mac desktop app's editor sees, to find why a word committed with Enter
 * comes out twice there and not in Safari. Only counts are kept of what is
 * written: how many lines, and how long the line with the caret and the one
 * before it are. ⌘⌥⇧I copies it.
 *
 * Temporary: to go once that is understood.
 */

type Entry = Record<string, string | number | boolean | null>;

const KEEP = 400;

/** Where the caret is, in counts only. */
function where(): Entry {
  const blocks = document.querySelectorAll('.ProseMirror [data-node-type="blockContainer"]');
  const anchor = document.getSelection()?.anchorNode ?? null;
  const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  const block = element?.closest('[data-node-type="blockContainer"]') ?? null;
  const index = block ? Array.prototype.indexOf.call(blocks, block) : -1;
  const own = (container: Element | null | undefined) =>
    container?.querySelector(":scope > .bn-block-content")?.textContent?.length ?? null;
  return {
    blocks: blocks.length,
    at: index,
    len: own(block),
    prevLen: index > 0 ? own(blocks[index - 1]) : null,
  };
}

export function startImeTrace(onCopied: () => void): () => void {
  if (typeof window === "undefined" || !inShell() || !isApple(navigator.userAgent)) {
    return () => {};
  }
  const entries: Entry[] = [];
  const pending = new Map<Event, Entry>();
  const start = performance.now();

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
    const composing = (
      document.querySelector(".ProseMirror") as
        (Element & { editor?: { view: { composing: boolean } } }) | null
    )?.editor?.view.composing;
    entry.pmComposing = composing ?? null;
    entries.push(entry);
    if (entries.length > KEEP) entries.shift();
    pending.set(event, entry);
    // What the page made of it, once every handler has run.
    queueMicrotask(() => {
      entry.prevented = event.defaultPrevented;
      pending.delete(event);
    });
    setTimeout(() => {
      const after = where();
      entry.blocksAfter = after.blocks;
      entry.lenAfter = after.len;
      entry.atAfter = after.at;
    }, 0);
  };

  /** A node as a short name: its tag, and the first of its classes or its node type. */
  const short = (node: Node | null): string => {
    if (!node) return "-";
    if (node.nodeType === Node.TEXT_NODE) return "#text";
    const element = node as Element;
    const kind =
      element.getAttribute?.("data-node-type") ?? element.getAttribute?.("data-content-type");
    const cls = element.classList?.[0];
    return `${element.nodeName.toLowerCase()}${kind ? `[${kind}]` : cls ? `.${cls}` : ""}`;
  };
  const push = (entry: Entry) => {
    entries.push({ t: Math.round(performance.now() - start), ...entry });
    if (entries.length > KEEP) entries.shift();
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
  // What the editor itself did: each transaction's steps, by kind and size.
  type Steps = { steps: { constructor: { name: string }; toJSON(): Record<string, unknown> }[] };
  type Editorish = {
    view: { composing: boolean };
    on(
      event: "transaction",
      handler: (props: { transaction: Steps & { docChanged: boolean } }) => void,
    ): void;
    off(
      event: "transaction",
      handler: (props: { transaction: Steps & { docChanged: boolean } }) => void,
    ): void;
  };
  let watched: Editorish | null = null;
  const onTransaction = ({ transaction }: { transaction: Steps & { docChanged: boolean } }) => {
    if (!transaction.docChanged) return;
    push({
      type: "pm:transaction",
      composing: watched?.view.composing ?? null,
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
    });
  };
  const watch = () => {
    const dom = document.querySelector(".ProseMirror") as (Element & { editor?: Editorish }) | null;
    const editor = dom?.editor ?? null;
    if (editor === watched) return;
    watched?.off("transaction", onTransaction);
    mutations.disconnect();
    watched = editor;
    if (!dom || !editor) return;
    editor.on("transaction", onTransaction);
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
    const text = [navigator.userAgent, ...entries.map((entry) => JSON.stringify(entry))].join("\n");
    void navigator.clipboard.writeText(text).then(onCopied);
  };
  window.addEventListener("keydown", copy, true);

  return () => {
    clearInterval(watching);
    mutations.disconnect();
    watched?.off("transaction", onTransaction);
    for (const type of types) document.removeEventListener(type, record, true);
    window.removeEventListener("keydown", copy, true);
  };
}
