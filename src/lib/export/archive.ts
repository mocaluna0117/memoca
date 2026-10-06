"use client";

import { type Block, BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import type { ConvexReactClient } from "convex/react";
import { SCHEMA } from "@/components/editor/schema";
import { vault } from "@/lib/crypto/vault";
import { db } from "@/lib/db";
import { decryptTitle } from "@/lib/hooks/use-decrypted";
import { idFromRef, loadAttachmentBlob } from "@/lib/media/attachments";
import { noteName } from "@/lib/note-name";
import { withStoredDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";
import type { Folder, Note } from "@/lib/types";
import { type ZipEntry, zip } from "./zip";

type AnyBlock = Block<
  typeof SCHEMA.blockSchema,
  typeof SCHEMA.inlineContentSchema,
  typeof SCHEMA.styleSchema
>;

/** What an export took in, and what it could not. */
export type ExportResult = {
  archive: Blob;
  /** The archive's name: Memoca and the day. */
  name: string;
  notes: number;
  files: number;
  /** Locked notes left out: the vault closed, or not asked for. */
  lockedLeftOut: number;
  /** Files a note shows that could not be had (not on this device, and no network). */
  filesMissing: number;
  /** Notes whose latest text could not be fetched: written as this device has them. */
  notesBehind: number;
};

export type ExportOptions = {
  client: ConvexReactClient;
  /** Fetches notes' text this device does not have yet (SyncEngine.fetchBodies). */
  fetchBodies?: (noteIds: string[]) => Promise<void>;
  /** Locked notes too, readable, with the vault open. */
  includeLocked: boolean;
  onProgress?: (done: number, total: number) => void;
  now?: Date;
};

/** Where the files notes show go, beside the notes' folders. */
const FILES = "ファイル";

/**
 * A name a file or a folder can have on any computer: without the
 * characters Windows or a Mac will not take, nor a dot or a space at its
 * end, and not too long.
 */
export function safeName(name: string, fallback: string): string {
  const cleaned = Array.from(
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, ""),
  )
    .slice(0, 80)
    .join("")
    .trim();
  return cleaned || fallback;
}

/** A name not yet taken among `taken`, which it is added to: "名前", then "名前 (2)", and so on. */
function unique(taken: Set<string>, name: string, extension = ""): string {
  let candidate = `${name}${extension}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1)
    candidate = `${name} (${n})${extension}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** A folder's name as it shows: its own, opened with the vault, or the name of what it is. */
async function folderName(folder: Folder): Promise<string> {
  if (folder.name) return folder.name;
  if (folder.system === "inbox") return "Inbox";
  if (folder.system === "templates") return "テンプレート";
  if (folder.nameSealed && vault.isUnlocked) {
    try {
      return await vault.openFolderName(folder.folderId, folder.nameSealed);
    } catch {
      // Left with the stand-in below.
    }
  }
  return folder.nameSealed ? "ロックされたフォルダ" : "無題のフォルダ";
}

/** A note's name as it shows in a list: its title (opened with the vault), or its first line. */
async function titleOf(note: Note): Promise<string> {
  let title = note.title;
  if (!title && note.locked && note.titleSealed && note.wrappedKey && vault.isUnlocked) {
    title = await decryptTitle(note).catch(() => null);
  }
  return noteName(title, note.preview).text;
}

/** Every block, those inside others too. */
function* everyBlock(blocks: AnyBlock[]): Generator<AnyBlock> {
  for (const block of blocks) {
    yield block;
    yield* everyBlock(block.children as AnyBlock[]);
  }
}

/**
 * Every note not in the trash, as Markdown, in folders as they are in
 * Memoca, with the files they show (images, PDFs, …) in a folder of their
 * own beside them, which the notes point at. One ZIP, for keeping on a
 * computer or taking to another app.
 *
 * A note whose latest text has not reached this device yet is fetched
 * first; one that cannot be is written as this device has it, and counted.
 * A locked note goes in only when asked for and with the vault open,
 * readable: the archive is not encrypted.
 */
export async function exportAll(options: ExportOptions): Promise<ExportResult> {
  const database = db();
  const now = options.now ?? new Date();
  const folders = (await database.folders.toArray()).filter((f) => !f.deletedAt && !f.purged);
  const notes = (await database.notes.toArray()).filter((n) => !n.deletedAt && !n.purged);

  const wanted = notes.filter(
    (note) => !note.locked || (options.includeLocked && vault.isUnlocked),
  );
  const lockedLeftOut = notes.length - wanted.length;

  // Text this device has not had yet, fetched first.
  const behind = async () => {
    const out: string[] = [];
    for (const note of wanted) {
      const body = await database.bodies.get(note.noteId);
      if (!body || body.keyEpoch !== note.keyEpoch || body.throughSeq < note.lastUpdateSeq) {
        out.push(note.noteId);
      }
    }
    return out;
  };
  const missing = await behind();
  if (missing.length > 0 && options.fetchBodies) {
    await options.fetchBodies(missing).catch(() => {});
  }
  const notesBehind = (await behind()).length;

  // Each folder's path, from the top, made of names any computer takes.
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]));
  const names = new Map<string, string>();
  const siblings = new Map<string, Set<string>>();
  const sorted = [...folders].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  for (const folder of sorted) {
    const parent = folder.parentId && byId.has(folder.parentId) ? folder.parentId : "";
    const taken = siblings.get(parent) ?? new Set<string>([FILES.toLowerCase()]);
    siblings.set(parent, taken);
    names.set(folder.folderId, unique(taken, safeName(await folderName(folder), "フォルダ")));
  }
  const pathOf = (folderId: string | null): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    for (let at = folderId; at && byId.has(at) && !seen.has(at); at = byId.get(at)!.parentId) {
      seen.add(at);
      path.unshift(names.get(at)!);
    }
    return path;
  };

  const editor = BlockNoteEditor.create({ schema: SCHEMA });
  const entries: ZipEntry[] = [];
  const filePaths = new Map<string, string | null>();
  const takenFiles = new Set<string>();
  const takenNotes = new Map<string, Set<string>>();
  let filesMissing = 0;
  let done = 0;
  options.onProgress?.(0, wanted.length);

  for (const note of wanted) {
    const folderPath = pathOf(note.folderId);
    const where = folderPath.join("/");
    const taken = takenNotes.get(where) ?? siblings.get(note.folderId ?? "") ?? new Set<string>();
    takenNotes.set(where, taken);
    const title = await titleOf(note);
    const fileName = unique(taken, safeName(title, "無題のメモ"), ".md");

    let blocks: AnyBlock[] = [];
    try {
      blocks = (await withStoredDoc(note.noteId, (doc) =>
        yXmlFragmentToBlocks(editor, bodyFragment(doc)),
      )) as AnyBlock[];
    } catch {
      // Could not be read (a locked note whose key this vault does not have): its title alone.
    }

    // Files it shows: each kept once, and pointed at from where the note is.
    const up = "../".repeat(folderPath.length);
    for (const block of everyBlock(blocks)) {
      const props = block.props as { url?: string; name?: string };
      const id = props.url ? idFromRef(props.url) : null;
      if (!id) continue;
      if (!filePaths.has(id)) {
        try {
          const blob = await loadAttachmentBlob(options.client, id);
          const path = `${FILES}/${unique(takenFiles, safeName(`${id.slice(-8)}-${props.name || "file"}`, id))}`;
          entries.push({ path, data: new Uint8Array(await blob.arrayBuffer()) });
          filePaths.set(id, path);
        } catch {
          filePaths.set(id, null);
          filesMissing += 1;
        }
      }
      const path = filePaths.get(id);
      if (path) props.url = encodeURI(`${up}${path}`);
    }

    const markdown = blocks.length > 0 ? await editor.blocksToMarkdownLossy(blocks) : "";
    const text = `# ${title}\n\n${markdown}`.trimEnd() + "\n";
    entries.push({
      path: [...folderPath, fileName].join("/"),
      data: new TextEncoder().encode(text),
      modified: new Date(note.updatedAt || now.getTime()),
    });
    done += 1;
    options.onProgress?.(done, wanted.length);
  }

  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const root = `Memoca-${day}`;
  return {
    archive: zip(entries.map((entry) => ({ ...entry, path: `${root}/${entry.path}` }))),
    name: `${root}.zip`,
    notes: wanted.length,
    files: [...filePaths.values()].filter(Boolean).length,
    lockedLeftOut,
    filesMissing,
    notesBehind,
  };
}
