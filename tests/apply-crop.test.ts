import "fake-indexeddb/auto";
import type { BlockNoteEditor } from "@blocknote/core";
import { beforeEach, describe, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { applyCrop, copiesLockedFile, revertCrop } from "@/lib/media/apply-crop";
import { idFromRef, refFor, stageUpload } from "@/lib/media/attachments";
import type { CroppedImage } from "@/lib/media/compress";
import type { Attachment, Note } from "@/lib/types";

const zero = { t: 0, d: "test" };

async function putNote(noteId: string, locked: boolean) {
  await db().notes.put({
    noteId,
    folderId: null,
    kind: "note",
    title: locked ? null : "メモ",
    preview: null,
    pinned: false,
    sortKey: "a",
    locked,
    keyEpoch: locked ? 1 : 0,
    deletedAt: null,
    purged: false,
    updatedAt: 0,
    ts: { title: zero, place: zero, pin: zero, trash: zero, lock: zero },
    seq: 0,
    lastUpdateSeq: 0,
  } as unknown as Note);
}

async function putAttachment(attachmentId: string, noteId: string, locked: boolean) {
  await db().attachments.put({
    attachmentId,
    noteId,
    status: "committed",
    bytes: 400,
    mime: locked ? null : "image/webp",
    name: locked ? null : "a.webp",
    locked,
    width: 400,
    height: 300,
    deletedAt: null,
    seq: 1,
  } as Attachment);
}

// jsdom has no object URLs; staging only needs a string back.
let nextUrl = 0;
URL.createObjectURL = () => `blob:test/${nextUrl++}`;
URL.revokeObjectURL = () => {};

/** jsdom's Blob does not survive fake-indexeddb, so a labelled stand-in is stored. */
const cropped = (size = 100): CroppedImage => ({
  blob: { size, type: "image/webp", label: "crop" } as unknown as Blob,
  mime: "image/webp",
  width: 200,
  height: 150,
  natural: { width: 400, height: 300 },
  kept: { x: 0, y: 0, width: 200, height: 150 },
});

const ORIGINAL = refFor("original");

/**
 * Just enough of an editor: one image block, and a record of what was
 * written to it. `editable` can be a function, to change between the checks
 * made before and after the file is staged.
 */
function fakeEditor(props: Record<string, unknown>, editable: boolean | (() => boolean) = true) {
  const block = {
    id: "b1",
    type: "image",
    props: { url: ORIGINAL, ...props } as Record<string, unknown>,
  };
  const updates: { props: Record<string, unknown> }[] = [];
  const editor = {
    get isEditable() {
      return typeof editable === "function" ? editable() : editable;
    },
    getBlock: (id: string) => (id === block.id ? block : undefined),
    updateBlock: (_id: string, update: { props: Record<string, unknown> }) => {
      updates.push(update);
      block.props = { ...block.props, ...update.props };
    },
  };
  return { editor: editor as unknown as BlockNoteEditor, block, updates };
}

const target = { blockId: "b1", originalUrl: ORIGINAL, name: "写真.png" };
const roomy = { quotaBytes: 10_000, usedBytes: 0, reservedBytes: 0, limits: { maxImageBytes: 5000 } };
const alive = () => true;

beforeEach(async () => {
  await resetLocalData();
  await putNote("n1", false);
  await putAttachment("original", "n1", false);
});

describe("applyCrop", () => {
  test("stages the crop as a new file and points the block at it", async () => {
    const { editor, block, updates } = fakeEditor({});
    const outcome = await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: roomy, alive });
    expect(outcome).toMatchObject({ status: "applied", before: undefined });
    const ref = outcome.status === "applied" ? outcome.ref : "";
    expect(block.props.url).toBe(ref);
    // No width set by hand, so none is invented.
    expect(updates).toEqual([{ props: { url: ref } }]);
    expect(await db().pendingUploads.get(idFromRef(ref)!)).toMatchObject({
      name: "写真.png",
      mime: "image/webp",
      locked: false,
    });
    // The original stays.
    expect(await db().attachments.get("original")).toBeTruthy();
  });

  test("a width set by hand shrinks with the image", async () => {
    const { editor, block } = fakeEditor({ previewWidth: 300 });
    const outcome = await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: roomy, alive });
    expect(outcome).toMatchObject({ status: "applied", before: 300 });
    expect(block.props.previewWidth).toBe(150);
  });

  test("over the allowance, nothing is staged and the block is left alone", async () => {
    const { editor, updates } = fakeEditor({});
    const full = { ...roomy, usedBytes: 9950 };
    expect(await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: full, alive })).toEqual({
      status: "tooLarge",
    });
    expect(await db().pendingUploads.count()).toBe(0);
    expect(updates).toEqual([]);
  });

  test("counts what this device is still to upload, which the server does not know about", async () => {
    await stageUpload({
      noteId: "n1",
      file: new File(["x"], "a.webp", { type: "image/webp" }),
      prepared: { ...cropped(300), width: 1, height: 1 },
    });
    const { editor } = fakeEditor({});
    const nearlyFull = { ...roomy, usedBytes: 9650 };
    // 9650 + 300 waiting + 100 is over 10000, although 9650 + 100 is not.
    expect(
      await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: nearlyFull, alive }),
    ).toEqual({ status: "tooLarge" });
    expect(await db().pendingUploads.count()).toBe(1);
  });

  test("an image over the per-image cap is refused however much room is left", async () => {
    const { editor } = fakeEditor({});
    expect(
      await applyCrop({ editor, noteId: "n1", target, image: cropped(5001), me: roomy, alive }),
    ).toEqual({ status: "tooLarge" });
  });

  test("a read-only note is not changed", async () => {
    const { editor, updates } = fakeEditor({}, false);
    expect(await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: roomy, alive })).toEqual({
      status: "readOnly",
    });
    expect(await db().pendingUploads.count()).toBe(0);
    expect(updates).toEqual([]);
  });

  test("a note that turns read-only while the file is staged gets nothing, and the file is taken back", async () => {
    let checks = 0;
    const { editor, updates } = fakeEditor({}, () => checks++ === 0);
    expect(await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: roomy, alive })).toEqual({
      status: "readOnly",
    });
    expect(await db().pendingUploads.count()).toBe(0);
    expect(await db().attachments.count()).toBe(1);
    expect(updates).toEqual([]);
  });

  test("a note closed while the file is staged gets nothing, and the file is taken back", async () => {
    let checks = 0;
    const { editor, updates } = fakeEditor({});
    const closing = () => checks++ === 0;
    expect(
      await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: roomy, alive: closing }),
    ).toEqual({ status: "gone" });
    expect(await db().pendingUploads.count()).toBe(0);
    expect(updates).toEqual([]);
  });

  test("a block that no longer shows the image is left alone", async () => {
    const { editor, block, updates } = fakeEditor({});
    block.props.url = refFor("other");
    expect(await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: roomy, alive })).toEqual({
      status: "changed",
    });
    expect(updates).toEqual([]);
  });

  test("a locked note's image pasted into an open note is not copied there as plaintext", async () => {
    await putAttachment("original", "locked-note", true);
    const { editor, updates } = fakeEditor({});
    expect(await applyCrop({ editor, noteId: "n1", target, image: cropped(), me: roomy, alive })).toEqual({
      status: "lockedSource",
    });
    expect(await db().pendingUploads.count()).toBe(0);
    expect(updates).toEqual([]);
  });

  test("in a locked note, the crop of its locked image is staged locked", async () => {
    await putNote("n2", true);
    await putAttachment("original", "n2", true);
    const { editor } = fakeEditor({});
    const outcome = await applyCrop({ editor, noteId: "n2", target, image: cropped(), me: roomy, alive });
    expect(outcome.status).toBe("applied");
    const ref = outcome.status === "applied" ? outcome.ref : "";
    expect((await db().pendingUploads.get(idFromRef(ref)!))?.locked).toBe(true);
  });
});

describe("copiesLockedFile", () => {
  test("a file that belongs to a locked note counts as locked before it is encrypted", async () => {
    await putNote("n2", true);
    await putAttachment("original", "n2", false);
    expect(await copiesLockedFile("n1", ORIGINAL)).toBe(true);
    expect(await copiesLockedFile("n2", ORIGINAL)).toBe(false);
  });

  test("a plain file, or a link that is not a stored file, is fine anywhere", async () => {
    expect(await copiesLockedFile("n1", ORIGINAL)).toBe(false);
    expect(await copiesLockedFile("n1", "https://example.com/a.png")).toBe(false);
  });
});

describe("revertCrop", () => {
  const applied = { ref: refFor("crop"), before: 300 };

  test("points the block back at the original, at its old width", () => {
    const { editor, block } = fakeEditor({ url: applied.ref, previewWidth: 150 });
    expect(revertCrop(editor, target, applied)).toBe("reverted");
    expect(block.props).toMatchObject({ url: ORIGINAL, previewWidth: 300 });
  });

  test("does nothing, and reports no failure, when the original is already back", () => {
    const { editor, updates } = fakeEditor({});
    expect(revertCrop(editor, target, applied)).toBe("already");
    expect(updates).toEqual([]);
  });

  test("leaves a block that has changed since", () => {
    const { editor, updates } = fakeEditor({ url: refFor("other") });
    expect(revertCrop(editor, target, applied)).toBe("changed");
    expect(updates).toEqual([]);
  });

  test("does not change a read-only note", () => {
    const { editor, updates } = fakeEditor({ url: applied.ref }, false);
    expect(revertCrop(editor, target, applied)).toBe("readOnly");
    expect(updates).toEqual([]);
  });
});
