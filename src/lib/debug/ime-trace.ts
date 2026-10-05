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

const KEEP = 200;

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
    for (const type of types) document.removeEventListener(type, record, true);
    window.removeEventListener("keydown", copy, true);
  };
}
