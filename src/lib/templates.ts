"use client";

import { type Block, BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import type * as Y from "yjs";
import { SCHEMA } from "@/components/editor/schema";
import { db } from "@/lib/db";
import { acquireDoc, releaseDoc, withStoredDoc } from "@/lib/sync/docs";
import {
  TEMPLATES_FOLDER_ID,
  createNote,
  ensureTemplatesFolder,
  renameNote,
} from "@/lib/sync/mutations";
import { bodyFragment } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";

/**
 * Templates are the notes of one folder (TEMPLATES_FOLDER_ID), written and
 * kept as any note is: a new note made from one is a copy of it, title and
 * body; one put into a note is its body, where the caret is.
 */
export { TEMPLATES_FOLDER_ID };

/** Whether a note is a template: in the folder of them, and readable (not locked). */
export const isTemplate = (note: Note) =>
  note.folderId === TEMPLATES_FOLDER_ID && !note.locked && note.deletedAt === null && !note.purged;

/** A line of a starter template: a heading, then the empty line to write under it. */
const section = (title: string, line: PartialBlock<typeof SCHEMA.blockSchema>["type"]) => [
  { type: "heading" as const, props: { level: 3 as const }, content: title },
  { type: line },
];

/** The templates the folder is made with, there to be used, changed or deleted. */
const STARTERS: { title: string; blocks: PartialBlock<typeof SCHEMA.blockSchema>[] }[] = [
  {
    title: "議事録",
    blocks: [
      ...section("日時・場所", "paragraph"),
      ...section("参加者", "bulletListItem"),
      ...section("議題", "numberedListItem"),
      ...section("決まったこと", "bulletListItem"),
      ...section("やること", "checkListItem"),
    ] as PartialBlock<typeof SCHEMA.blockSchema>[],
  },
  {
    title: "日記",
    blocks: [
      ...section("今日のできごと", "paragraph"),
      ...section("よかったこと", "bulletListItem"),
      ...section("明日やること", "checkListItem"),
    ] as PartialBlock<typeof SCHEMA.blockSchema>[],
  },
];

/**
 * The folder of templates, made with the starters the first time it is
 * needed on a device that has none. Its id is the same everywhere, so two
 * devices making it at once make one; each would add the starters, though,
 * which takes making it on two at once before either has synced.
 */
export async function prepareTemplates(): Promise<string> {
  const { folderId, made } = await ensureTemplatesFolder();
  const already = await db()
    .notes.filter((note) => note.folderId === folderId && !note.purged)
    .count();
  if (!made || already > 0) return folderId;
  const editor = BlockNoteEditor.create({ schema: SCHEMA });
  // The first last, as a folder's newest notes come first.
  for (const starter of [...STARTERS].reverse()) {
    const noteId = await createNote({ folderId, title: starter.title });
    await writeBody(noteId, (fragment) => {
      blocksToYXmlFragment(editor as never, starter.blocks as never, fragment);
    });
  }
  return folderId;
}

/** Writes into a note's body as an edit of it: saved, and sent, as any is. */
async function writeBody(noteId: string, write: (fragment: Y.XmlFragment) => void): Promise<void> {
  const doc = await acquireDoc(noteId);
  try {
    doc.transact(() => write(bodyFragment(doc)));
  } finally {
    await releaseDoc(noteId);
  }
}

/**
 * A copy of a note's body, to put into another: its blocks, as this device
 * has them. Empty if none of it is here yet.
 */
async function bodyCopy(noteId: string): Promise<(Y.XmlElement | Y.XmlText)[]> {
  return withStoredDoc(noteId, (doc) =>
    bodyFragment(doc)
      .toArray()
      .map((node) => (node as Y.XmlElement | Y.XmlText).clone()),
  );
}

/** A template not on this device yet, its body still to arrive. */
export class TemplateUnavailableError extends Error {
  constructor() {
    super("template unavailable");
    this.name = "TemplateUnavailableError";
  }
}

/**
 * Fills a note just made with a template: its title, and a copy of its body
 * (files and all: the same files, which a note may share). In a locked note
 * both are encrypted as any edit is.
 */
export async function fillFromTemplate(noteId: string, templateId: string): Promise<void> {
  const template = await db().notes.get(templateId);
  if (!template) throw new TemplateUnavailableError();
  const body = await bodyCopy(templateId);
  if (body.length === 0 && template.preview) throw new TemplateUnavailableError();
  if (template.title) await renameNote(noteId, template.title);
  if (body.length > 0) await writeBody(noteId, (fragment) => fragment.insert(0, body));
}

/**
 * Fills a note just made with a template's body only, its title left as it
 * is: a day's note, named by its day (lib/journal). Nothing when none of
 * the template is on this device yet.
 */
export async function fillBodyFromTemplate(noteId: string, templateId: string): Promise<void> {
  const body = await bodyCopy(templateId);
  if (body.length > 0) await writeBody(noteId, (fragment) => fragment.insert(0, body));
}

/**
 * Keeps a copy of a note as a template: a new note in the folder of them,
 * with its title and body. Not for a locked note: the copy would be
 * plaintext.
 */
export async function saveAsTemplate(noteId: string, title: string): Promise<string> {
  const note = await db().notes.get(noteId);
  if (!note || note.locked) throw new Error("locked");
  const folderId = await prepareTemplates();
  const templateId = await createNote({ folderId, title });
  const body = await bodyCopy(noteId);
  if (body.length > 0) await writeBody(templateId, (fragment) => fragment.insert(0, body));
  return templateId;
}

type B = typeof SCHEMA.blockSchema;
type I = typeof SCHEMA.inlineContentSchema;
type S = typeof SCHEMA.styleSchema;

/** A block, and what is inside it, with no ids: new ones are given where it is put. */
function withoutIds(block: Block<B, I, S>): PartialBlock<B, I, S> {
  const rest: Partial<Block<B, I, S>> = { ...block };
  delete rest.id;
  return { ...rest, children: block.children.map(withoutIds) } as PartialBlock<B, I, S>;
}

/**
 * Puts a template's blocks into a note open in `editor`, where its caret
 * is: in place of the line it is on when that line is empty (the / typed
 * there has gone), after it otherwise. Throws TemplateUnavailableError when
 * none of it is on this device yet.
 */
export async function insertTemplate(
  editor: BlockNoteEditor<B, I, S>,
  templateId: string,
): Promise<void> {
  const template = await db().notes.get(templateId);
  const blocks = (
    await withStoredDoc(templateId, (doc) => yXmlFragmentToBlocks(editor, bodyFragment(doc)))
  ).map(withoutIds);
  if (blocks.length === 0) {
    if (template?.preview) throw new TemplateUnavailableError();
    return;
  }
  const { block } = editor.getTextCursorPosition();
  const empty =
    Array.isArray(block.content) && block.content.length === 0 && block.children.length === 0;
  // Whatever line it is (an empty list item, say), as BlockNote's own / menu has it.
  if (empty) editor.replaceBlocks([block], blocks);
  else editor.insertBlocks(blocks, block, "after");
}
