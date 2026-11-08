"use client";

import * as Y from "yjs";
import { bodyFragment } from "@/lib/sync/ydoc";

/** What a repair of the Todo writes as: its own, stored and sent as any edit. */
export const TODO_REPAIR = Symbol("memoca:todo-repair");

const isGroup = (node: unknown): node is Y.XmlElement =>
  node instanceof Y.XmlElement && node.nodeName === "blockGroup";
const idOf = (node: unknown) =>
  node instanceof Y.XmlElement ? (node.getAttribute("id") as string | undefined) : undefined;
/** An item with nothing in it: the empty line a device's editor starts a list with. */
const isEmpty = (container: unknown) => {
  if (!(container instanceof Y.XmlElement)) return false;
  const children = container.toArray();
  return children.length === 1 && children[0] instanceof Y.XmlElement && children[0].length === 0;
};
/** An item as it is, id and all: two the same are one item copied. */
const whole = (node: unknown) => (node instanceof Y.XmlElement ? node.toString() : "");

/** A short hash of a text (FNV-1a), the same on every device. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Puts the Todo's list back together where two devices began it apart (each
 * made the note before it had the other's, and each wrote a list of its
 * own into it): the editor shows the first list alone, and what was written
 * into the other was out of sight. The other's items go after the first's,
 * and the other goes; the empty lines the lists began with go too.
 *
 * Nothing written is lost: only an item there twice exactly (two devices
 * put the lists together at once, each copying the same items) is kept
 * once. Two of the same id but different (each device's first line has
 * the editor's one first id) are both kept, the one copied given an id of
 * its own, made of the two, so that two devices doing this at once give it
 * the same id, and both end with the same list. Whether anything was done.
 */
export function joinTodoLists(doc: Y.Doc): boolean {
  const fragment = bodyFragment(doc);
  const groups = fragment.toArray().filter(isGroup);
  const first = groups[0];
  if (!first) return false;
  const items = first.toArray().map(whole);
  const twice = items.some((item, at) => items.indexOf(item) !== at);
  if (groups.length < 2 && !twice) return false;
  doc.transact(() => {
    const there = new Set(first.toArray().map(whole));
    const ids = new Set(first.toArray().map(idOf).filter(Boolean));
    for (const other of groups.slice(1)) {
      const adds: Y.XmlElement[] = [];
      for (const item of other.toArray()) {
        if (!(item instanceof Y.XmlElement) || isEmpty(item) || there.has(whole(item))) continue;
        const copy = item.clone();
        const id = idOf(item);
        if (id && ids.has(id)) copy.setAttribute("id", `${id}-${hashOf(whole(item))}`);
        there.add(whole(item));
        if (id) ids.add(idOf(copy) ?? id);
        adds.push(copy);
      }
      if (adds.length > 0) first.insert(first.length, adds);
    }
    for (let at = fragment.length - 1; at >= 0; at -= 1) {
      const node = fragment.get(at);
      if (node !== first && isGroup(node)) fragment.delete(at, 1);
    }
    // Lists put together: the empty lines they began with go too (whichever
    // list is first, which is Yjs's to say), while something is written.
    const written = first.toArray().some((item) => !isEmpty(item));
    const kept = new Set<string>();
    for (let at = 0; at < first.length; ) {
      const item = first.get(at);
      const key = whole(item);
      if (kept.has(key) || (groups.length > 1 && written && isEmpty(item))) {
        first.delete(at, 1);
        continue;
      }
      kept.add(key);
      at += 1;
    }
  }, TODO_REPAIR);
  return true;
}
