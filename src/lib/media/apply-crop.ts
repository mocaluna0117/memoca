"use client";

import type { BlockNoteEditor } from "@blocknote/core";
import { db } from "@/lib/db";
import {
  discardStaged,
  fileLimit,
  fitsAllowance,
  idFromRef,
  isLockedFile,
  queuedBytes,
  stageUpload,
} from "./attachments";
import type { CroppedImage } from "./compress";
import { scaledPreviewWidth } from "./crop";

/**
 * The image a crop was started on, captured when the dialog opens: the
 * toolbar that opened it is gone by then, and the block may change before the
 * crop is done. The crop only lands if the block still shows `originalUrl`.
 */
export type CropTarget = { blockId: string; originalUrl: string; name: string };

/** A crop that landed, with what 元に戻す needs to take it back. */
export type AppliedCrop = {
  ref: string;
  /** The block's width before the crop, if one had been set. */
  before: number | undefined;
};

export type CropOutcome =
  | ({ status: "applied" } & AppliedCrop)
  /** The block no longer shows the image the crop was made from. */
  | { status: "changed" }
  /** The note cannot be edited now, say while it waits to be encrypted. */
  | { status: "readOnly" }
  /** The image is kept encrypted and this note is not: see {@link copiesLockedFile}. */
  | { status: "lockedSource" }
  /** Over the account's allowance or the per-image cap. */
  /** `limit`: over the limit for one image, rather than the account's room. */
  | { status: "tooLarge"; limit?: number }
  /** The editor went away while the file was being staged. */
  | { status: "gone" };

type Refusal = Exclude<CropOutcome, { status: "applied" }>["status"];
type Allowance = Parameters<typeof fitsAllowance>[0];

const stillShows = (editor: BlockNoteEditor, blockId: string, url: string) => {
  const block = editor.getBlock(blockId);
  return block?.type === "image" && block.props.url === url ? block : null;
};

/**
 * True when the image is kept encrypted but this note is not, as with one
 * pasted from a locked note into an open one. A crop made here would be
 * stored, and cached on the device, as plaintext.
 */
export async function copiesLockedFile(noteId: string, url: string): Promise<boolean> {
  const attachmentId = idFromRef(url);
  if (!attachmentId || !(await isLockedFile(attachmentId))) return false;
  return (await db().notes.get(noteId))?.locked !== true;
}

/**
 * Saves a crop as a new attachment and points the block at it, in one step
 * that undo takes back as one.
 *
 * The original stays stored. Everything that could stop the crop is asked
 * again once the file is staged, since the note can change in the meantime;
 * a file staged for nothing is taken back before anything refers to it.
 */
export async function applyCrop({
  editor,
  noteId,
  target,
  image,
  me,
  alive,
}: {
  editor: BlockNoteEditor;
  noteId: string;
  target: CropTarget;
  image: CroppedImage;
  /** The account's figures, when known; the server has the last word anyway. */
  me: Allowance | null | undefined;
  /** False once the editor has gone, say because the note was closed. */
  alive: () => boolean;
}): Promise<CropOutcome> {
  const { blockId, originalUrl, name } = target;
  // The checks that need the database come first, so nothing can change
  // between the ones on the editor and the edit itself.
  const refusal = async (): Promise<Refusal | null> => {
    if (await copiesLockedFile(noteId, originalUrl)) return "lockedSource";
    if (!alive()) return "gone";
    if (!editor.isEditable) return "readOnly";
    if (!stillShows(editor, blockId, originalUrl)) return "changed";
    return null;
  };

  const early = await refusal();
  if (early) return { status: early };
  if (me && !fitsAllowance(me, image.blob.size, await queuedBytes())) {
    const limit = fileLimit(me, "image");
    return limit !== undefined && image.blob.size > limit ? { status: "tooLarge", limit } : { status: "tooLarge" };
  }

  const ref = await stageUpload({
    noteId,
    file: new File([image.blob], name || "image", { type: image.mime }),
    prepared: image,
  });
  const late = await refusal();
  if (late) {
    await discardStaged(idFromRef(ref)!);
    return { status: late };
  }

  // A width someone set by hand shrinks with the image, so what is left
  // appears at the scale it had; otherwise the image just fills the column.
  const before = stillShows(editor, blockId, originalUrl)!.props.previewWidth;
  const previewWidth =
    before === undefined
      ? undefined
      : scaledPreviewWidth(before, image.kept.width, image.natural.width);
  editor.updateBlock(blockId, {
    props: { url: ref, ...(previewWidth === undefined ? {} : { previewWidth }) },
  });
  return { status: "applied", ref, before };
}

/**
 * Points the block back at the original, for 元に戻す. `already` when it
 * shows the original again by other means, such as ⌘Z.
 */
export function revertCrop(
  editor: BlockNoteEditor,
  target: CropTarget,
  applied: AppliedCrop,
): "reverted" | "already" | "readOnly" | "changed" {
  const { blockId, originalUrl } = target;
  if (stillShows(editor, blockId, originalUrl)) return "already";
  if (!editor.isEditable) return "readOnly";
  if (!stillShows(editor, blockId, applied.ref)) return "changed";
  editor.updateBlock(blockId, {
    props: {
      url: originalUrl,
      ...(applied.before === undefined ? {} : { previewWidth: applied.before }),
    },
  });
  return "reverted";
}
