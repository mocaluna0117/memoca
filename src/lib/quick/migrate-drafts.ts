"use client";

import * as Y from "yjs";
import { db } from "@/lib/db";
import { stageUpload } from "@/lib/media/attachments";
import {
  appendBlocks,
  appendParagraphs,
  migrateOldQuickBody,
  quickKey,
  referencedImages,
  setQuickImage,
} from "@/lib/quick/body";
import { META } from "@/lib/db/meta";
import { type QuickDraft, clearDraft, loadDraft, loadTabs, renameTabs } from "@/lib/quick/draft";
import { makeTabNote, writeSaved } from "@/lib/quick/tabs";
import { quickLines } from "@/lib/quick/text";
import { QUICK_TAB_PREFIX, TODO_TAB_ID, isQuickTab } from "@/lib/quick/todo-id";
import { acquireDoc, flushDoc, releaseDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";

/**
 * Makes the quick note's drafts this device kept of its own (before the
 * tabs were the account's) its tabs' notes (lib/quick/tabs), the same on
 * every device from then on: each draft with anything in it a note of its
 * own (its id the tab's, after the prefix), what it held written into it,
 * its images sent up as the note's files (where it was saved before, the
 * saved note's own, reused) in their places, and what it was saved as kept
 * in it. An empty one's tab goes. Each draft forgotten once its note holds
 * it, here; the note goes up as any edit does, offline too.
 *
 * Once a device: none left, nothing to do. One window at a time (with a
 * lock), so that two opening at once do not make two of each. One cut short
 * starts again where it was: a note written into already is not written
 * into again.
 */
export async function migrateLocalDrafts(userKey: string): Promise<void> {
  if (!userKey) return;
  // Nothing of the kind left (as it is, every time after the first): not
  // waited for, as the quick note opens.
  if (!(await anyLeft(userKey))) return;
  const run = () => migrate(userKey);
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) await locks.request(`memoca-quick-drafts:${userKey}`, run);
  else await run();
}

/** Whether this device keeps a draft of its own, or a tab of one, still to be made a tab's note. */
async function anyLeft(userKey: string): Promise<boolean> {
  const database = db();
  const [drafts, tabs] = await Promise.all([
    database.meta.where("key").startsWith(`${META.quickDraft}`).count(),
    database.meta.get(`${META.quickTabs}:${userKey}`),
  ]);
  if (drafts > 0) return true;
  const ids = (tabs?.value as { ids?: string[] } | undefined)?.ids ?? [];
  return ids.some((id) => id !== TODO_TAB_ID && !isQuickTab(id));
}

async function migrate(userKey: string): Promise<void> {
  const tabs = await loadTabs(userKey);
  // Each tab's of this device's own, and any draft left of one not among
  // them (one cut short before, kept to be tried again).
  const left = (await db().meta.where("key").startsWith(`${META.quickDraft}:`).primaryKeys()).map((key) =>
    String(key).slice(META.quickDraft.length + 1),
  );
  const ids = [...new Set([...tabs.ids.filter((id) => id !== TODO_TAB_ID), ...left])];
  const renames = new Map<string, string | null>();
  const added: string[] = [];
  const out = (id: string) => {
    if (tabs.ids.includes(id) && !isQuickTab(id)) renames.set(id, null);
  };
  for (const id of ids) {
    const draft = await loadDraft(userKey, id);
    if (!draft) {
      // A tab's own already, or nothing kept of it: an old one's tab goes.
      out(id);
      continue;
    }
    const noteId = isQuickTab(id) ? id : `${QUICK_TAB_PREFIX}${id}`;
    if (draft.text.trim() === "" && (draft.images ?? []).length === 0) {
      out(id);
      await clearDraft(userKey, id);
      continue;
    }
    try {
      // Forgotten here once all of it is in the note; an image that could
      // not be sent leaves it kept, to be tried again the next time.
      if (await moveDraft(noteId, draft)) await clearDraft(userKey, id);
      if (tabs.ids.includes(id)) renames.set(id, noteId);
      else added.push(noteId);
    } catch {
      // Kept as it is, to be tried again the next time; not a tab meanwhile.
      out(id);
    }
  }
  if (renames.size > 0 || added.length > 0) await renameTabs(userKey, renames, added);
}

/**
 * Writes a draft into its tab's note: what it held (once: a note written
 * into already is not written into again), its images sent up as the
 * note's files in their places, and what it was saved as. Whether every
 * image went.
 */
async function moveDraft(noteId: string, draft: QuickDraft): Promise<boolean> {
  const images = draft.images ?? [];
  if (!(await db().notes.get(noteId))) await makeTabNote(noteId);
  const doc = await acquireDoc(noteId);
  try {
    if (bodyFragment(doc).length === 0) {
      if (draft.body) Y.applyUpdate(doc, draft.body);
      // A draft from before the quick note had an editor: its lines.
      else appendParagraphs(doc, quickLines(draft.text));
      migrateOldQuickBody(doc);
    }
    // Its images, as the note's files (where it was saved before, the saved
    // note's own, reused): each where it was, or (a strip of them, before
    // they went where they were pasted) after what is written. One that
    // could not be stays as it was, to be tried again.
    const refs = new Map<string, string>();
    for (const image of images) {
      try {
        refs.set(
          image.key,
          image.ref ??
            (await stageUpload({
              noteId,
              file: new File([image.blob], image.name, { type: image.mime }),
              prepared: { blob: image.blob, mime: image.mime, width: image.width, height: image.height },
            })),
        );
      } catch {
        // Tried again the next time.
      }
    }
    const shown = referencedImages(doc);
    doc.transact(() => {
      for (const [key, ref] of refs) setQuickImage(doc, key, ref);
      const apart = images.filter((image) => !shown.includes(image.key) && refs.has(image.key));
      if (apart.length > 0) {
        appendBlocks(
          doc,
          apart.map((image) => ({ kind: "image" as const, url: refs.get(image.key)!, name: image.name })),
        );
      }
    });
    if (draft.saved) {
      // Saved as it was kept: saved as it is now, its images' references and all.
      const asKept = draft.key !== undefined && draft.saved.key === draft.key;
      writeSaved(doc, {
        ...draft.saved,
        key: asKept ? quickKey(doc) : draft.saved.key,
        images: draft.saved.images.map((key) => refs.get(key) ?? key),
      });
    }
    return refs.size === images.length;
  } finally {
    await flushDoc(noteId).catch(() => undefined);
    await releaseDoc(noteId);
  }
}
