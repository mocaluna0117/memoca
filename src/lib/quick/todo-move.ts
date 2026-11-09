"use client";

import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { uuidv4 } from "uuidv7";
import * as Y from "yjs";
import { SCHEMA } from "@/components/editor/schema";
import { readyTodo } from "@/lib/quick/todo";
import { joinTodoLists } from "@/lib/quick/todo-repair";
import type { SyncEngine } from "@/lib/sync/engine";
import type { StatusStore } from "@/lib/sync/status-store";
import { acquireDoc, flushDoc, releaseDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";

/** What moving lines into the Todo writes as: this device's own, stored and sent as any edit. */
export const TODO_MOVE = Symbol("memoca:todo-move");

/** A block, as BlockNote gives one: what of it is read here. */
export type MovedBlock = {
  id: string;
  type: string;
  content?: unknown;
  children: MovedBlock[];
};

/** A block for the Todo, as BlockNote takes one. */
export type TodoBlock = {
  id: string;
  type: "checkListItem" | "paragraph";
  props?: { checked: boolean };
  content: unknown[];
  children: TodoBlock[];
};

/** A block's line of text, if it has one (a table's cells, an image, have none). */
const lineOf = (block: MovedBlock): unknown[] | null => (Array.isArray(block.content) ? block.content : null);

/** The text of a line, its links' too. */
function textOf(content: unknown[]): string {
  return content
    .map((run) => {
      const part = run as { type?: string; text?: string; content?: unknown };
      if (typeof part.text === "string") return part.text;
      return Array.isArray(part.content) ? textOf(part.content) : "";
    })
    .join("");
}

const written = (content: unknown[] | null): content is unknown[] => content !== null && textOf(content).trim() !== "";

/** Every line under a block, however far in, with text in it: the details of the item it becomes. */
function detailsOf(children: MovedBlock[]): TodoBlock[] {
  return children.flatMap((child) => {
    const line = lineOf(child);
    const own: TodoBlock[] = written(line)
      ? [{ id: uuidv4(), type: "paragraph", content: line, children: [] }]
      : [];
    return [...own, ...detailsOf(child.children)];
  });
}

/**
 * The quick note's lines as the Todo's items: each block at its top with
 * text in it an item, to do, its text kept as it is (links and all), and
 * the lines under it (a list's, a toggle's) its details. Empty lines, and
 * what has no text (an image, a table), go; the lines under an empty one
 * are items of their own.
 */
export function todoBlocksOf(blocks: MovedBlock[]): TodoBlock[] {
  return blocks.flatMap((block): TodoBlock[] => {
    const line = lineOf(block);
    const details = detailsOf(block.children);
    if (written(line)) {
      return [{ id: uuidv4(), type: "checkListItem", props: { checked: false }, content: line, children: details }];
    }
    return details.map((detail) => ({ ...detail, type: "checkListItem", props: { checked: false } }));
  });
}

/** Whether a block of the Todo's top is an item done. */
function isDone(container: unknown): boolean {
  if (!(container instanceof Y.XmlElement)) return false;
  const item = container.get(0);
  if (!(item instanceof Y.XmlElement) || item.nodeName !== "checkListItem") return false;
  const checked = item.getAttribute("checked") as unknown;
  return checked === true || checked === "true";
}

/**
 * Writes items into the Todo's document, after those to do (before the
 * first done), each as BlockNote would write it. A headless editor makes
 * them, in a document of their own, and they are copied in.
 */
export function insertIntoTodo(doc: Y.Doc, blocks: TodoBlock[]): void {
  if (blocks.length === 0) return;
  const scratch = new Y.Doc();
  const made = scratch.getXmlFragment("made");
  const editor = BlockNoteEditor.create({ schema: SCHEMA });
  blocksToYXmlFragment(editor as never, blocks as never, made);
  const group = made.get(0);
  if (!(group instanceof Y.XmlElement)) return;
  const containers = group.toArray().flatMap((node) => (node instanceof Y.XmlElement ? [node.clone()] : []));
  const fragment = bodyFragment(doc);
  doc.transact(() => {
    let list = fragment.get(0);
    if (!(list instanceof Y.XmlElement) || list.nodeName !== "blockGroup") {
      list = new Y.XmlElement("blockGroup");
      fragment.insert(0, [list]);
    }
    const items = (list as Y.XmlElement).toArray();
    const firstDone = items.findIndex(isDone);
    (list as Y.XmlElement).insert(firstDone < 0 ? items.length : firstDone, containers);
  }, TODO_MOVE);
}

/** Takes items out of the Todo's document again, by their ids (those moved in, for 元に戻す). */
export function removeFromTodo(doc: Y.Doc, ids: readonly string[]): void {
  const list = bodyFragment(doc).get(0);
  if (!(list instanceof Y.XmlElement)) return;
  const gone = new Set(ids);
  doc.transact(() => {
    for (let at = list.length - 1; at >= 0; at -= 1) {
      const node = list.get(at);
      if (node instanceof Y.XmlElement && gone.has(node.getAttribute("id") as string)) list.delete(at, 1);
    }
  }, TODO_MOVE);
}

/** The Todo's note, ready to be written into (see readyTodo), its document held while `write` runs. */
async function withTodo(
  sync: { status: StatusStore; engine: () => SyncEngine | null },
  write: (doc: Y.Doc) => void,
): Promise<string> {
  const noteId = await readyTodo(sync.status, sync.engine, () => false);
  const doc = await acquireDoc(noteId);
  try {
    // Two lists begun apart, put together before anything is written into them.
    joinTodoLists(doc);
    write(doc);
    await flushDoc(noteId);
  } finally {
    await releaseDoc(noteId);
  }
  return noteId;
}

/** Moves the quick note's lines into the Todo (see todoBlocksOf): the items' ids, to take them out again. */
export async function moveIntoTodo(
  blocks: MovedBlock[],
  sync: { status: StatusStore; engine: () => SyncEngine | null },
): Promise<string[]> {
  const items = todoBlocksOf(blocks);
  if (items.length === 0) return [];
  await withTodo(sync, (doc) => insertIntoTodo(doc, items));
  return items.map((item) => item.id);
}

/** Takes the items moved into the Todo out again. */
export async function takeOutOfTodo(
  ids: readonly string[],
  sync: { status: StatusStore; engine: () => SyncEngine | null },
): Promise<void> {
  await withTodo(sync, (doc) => removeFromTodo(doc, ids));
}
