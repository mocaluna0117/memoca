import "fake-indexeddb/auto";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { ConvexReactClient } from "convex/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { SCHEMA } from "@/components/editor/schema";
import { db, resetLocalData } from "@/lib/db";
import { refFor } from "@/lib/media/ref";
import { bodyFragment } from "@/lib/sync/ydoc";
import type { Folder, Note } from "@/lib/types";
import { zero } from "./helpers/seed";

vi.mock("@/lib/media/attachments", async (actual) => ({
  ...(await actual<typeof import("@/lib/media/attachments")>()),
  loadAttachmentBlob: async (_client: unknown, id: string) => {
    if (id === "gone") throw new Error("offline");
    return new Blob([`画像 ${id}`], { type: "image/webp" });
  },
}));

const { exportAll, safeName } = await import("@/lib/export/archive");

const folder = (folderId: string, name: string, parentId: string | null = null): Folder => ({
  folderId,
  parentId,
  name,
  icon: null,
  sortKey: folderId,
  locked: false,
  system: null,
  deletedAt: null,
  purged: false,
  ts: { name: zero, place: zero, trash: zero, lock: zero } as Folder["ts"],
  seq: 1,
});

const note = (
  noteId: string,
  title: string | null,
  folderId: string | null,
  extra: Partial<Note> = {},
): Note => ({
  noteId,
  folderId,
  kind: "note",
  title,
  preview: null,
  pinned: false,
  sortKey: noteId,
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 1,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 1,
  updatedAt: Date.UTC(2026, 9, 1),
  ...extra,
});

/** A note as this device keeps it: its row, its text as one update, and how far that goes. */
async function keep(row: Note, blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create({ schema: SCHEMA }) as unknown as BlockNoteEditor;
  editor.replaceBlocks(editor.document, blocks);
  const doc = new Y.Doc();
  blocksToYXmlFragment(editor, editor.document, bodyFragment(doc));
  await db().notes.put(row);
  await db().updates.add({
    noteId: row.noteId,
    seq: 1,
    opId: `op-${row.noteId}`,
    keyEpoch: 0,
    data: Y.encodeStateAsUpdate(doc),
    pushed: 1,
    createdAt: 0,
  });
  await db().bodies.put({ noteId: row.noteId, throughSeq: 1, keyEpoch: 0, text: "", updatedAt: 0 });
}

/** The files in an archive (stored, as zip.ts writes it), by path, as text. */
async function unzip(archive: Blob): Promise<Map<string, string>> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    files.set(name, decoder.decode(bytes.subarray(start, start + size)));
    at = start + size;
  }
  return files;
}

const client = {} as ConvexReactClient;
const NOW = new Date(2026, 9, 6, 12);

beforeEach(async () => {
  await resetLocalData();
});

describe("exporting every note", () => {
  test("as Markdown, in their folders, with the files they show beside them", async () => {
    await db().folders.bulkPut([folder("f1", "仕事"), folder("f2", "会議", "f1")]);
    await keep(note("n1", "議事録", "f2"), [
      { type: "heading", content: "決まったこと" },
      { type: "bulletListItem", content: "来週までに見積もり" },
      { type: "image", props: { url: refFor("img-12345678"), name: "図.webp" } },
    ]);
    await keep(note("n2", null, null, { preview: "題のないメモの一行目" }), [
      { type: "paragraph", content: "題のないメモの一行目" },
    ]);

    const result = await exportAll({ client, includeLocked: false, now: NOW });
    expect(result.name).toBe("Memoca-2026-10-06.zip");
    expect(result).toMatchObject({ notes: 2, files: 1, filesMissing: 0, lockedLeftOut: 0 });

    const files = await unzip(result.archive);
    const minutes = files.get("Memoca-2026-10-06/仕事/会議/議事録.md")!;
    expect(minutes).toContain("# 議事録");
    expect(minutes).toContain("決まったこと");
    expect(minutes).toMatch(/[*-] 来週までに見積もり/);
    // The image, pointed at from where the note is, two folders down.
    expect(minutes).toContain(encodeURI("../../ファイル/12345678-図.webp"));
    expect(files.get("Memoca-2026-10-06/ファイル/12345678-図.webp")).toBe("画像 img-12345678");
    expect(files.get("Memoca-2026-10-06/題のないメモの一行目.md")).toContain(
      "# 題のないメモの一行目",
    );
  });

  test("leaves out what is in the trash, and locked notes with the vault closed", async () => {
    await keep(note("n1", "残す", null), [{ type: "paragraph", content: "a" }]);
    await keep(note("n2", "捨てた", null, { deletedAt: 1 }), [{ type: "paragraph", content: "b" }]);
    await keep(note("n3", null, null, { locked: true }), [{ type: "paragraph", content: "秘密" }]);
    const result = await exportAll({ client, includeLocked: true, now: NOW });
    const files = await unzip(result.archive);
    expect([...files.keys()]).toEqual(["Memoca-2026-10-06/残す.md"]);
    expect(result.lockedLeftOut).toBe(1);
  });

  test("two notes of one name are both kept, and a file that cannot be had is counted", async () => {
    await keep(note("n1", "同じ", null), [{ type: "paragraph", content: "一つ目" }]);
    await keep(note("n2", "同じ", null), [
      { type: "image", props: { url: refFor("gone"), name: "x.webp" } },
    ]);
    const result = await exportAll({ client, includeLocked: false, now: NOW });
    const files = await unzip(result.archive);
    expect(files.has("Memoca-2026-10-06/同じ.md")).toBe(true);
    expect(files.has("Memoca-2026-10-06/同じ (2).md")).toBe(true);
    expect(result.filesMissing).toBe(1);
  });

  test("a note this device is behind on is fetched first", async () => {
    await keep(note("n1", "遅れ", null, { lastUpdateSeq: 5 }), [
      { type: "paragraph", content: "a" },
    ]);
    const fetchBodies = vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        await db().bodies.put({ noteId: id, throughSeq: 5, keyEpoch: 0, text: "", updatedAt: 0 });
      }
    });
    const result = await exportAll({ client, includeLocked: false, fetchBodies, now: NOW });
    expect(fetchBodies).toHaveBeenCalledWith(["n1"]);
    expect(result.notesBehind).toBe(0);
  });
});

describe("a name for a file", () => {
  test("loses what a computer would not take, and is never empty", () => {
    expect(safeName('a/b:c*?"<>|. ', "x")).toBe("a b c");
    expect(safeName("   ", "無題のメモ")).toBe("無題のメモ");
  });
});
