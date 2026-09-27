"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { acquireDoc, flushDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import { attachmentRefs } from "@/lib/sync/ydoc";
import {
  type Allowance,
  AttachmentUnavailableError,
  discardStaged,
  fileLimit,
  fitsAllowance,
  loadAttachmentBlob,
  queuedBytes,
  sealedMeta,
  stageUpload,
} from "./attachments";
import { prepareImage } from "./compress";
import { idFromRef, refFor } from "./ref";
import { rewriteRefInDoc, withRelockLock } from "./relock-copies";

/**
 * Images stored before this device could write WebP (Safari, before S4)
 * went up as PNG or JPEG, often many times the size WebP comes to. These
 * write such an image again as images are written now, put the copy in its
 * place in every note that shows it, and tell the server the original was
 * replaced, so it goes a day after it stops being used rather than thirty.
 * GIFs are left: a canvas keeps only their first frame.
 */

/** Types worth writing again as WebP. */
const CONVERTIBLE = new Set(["image/png", "image/jpeg"]);

/** A copy is kept only when it comes to less than this share of the original. */
export const KEEP_BELOW = 0.9;

/** Files one ask of the server may name (convex/lib/constants.ts MAX_REPLACED_PER_CALL). */
const PER_ASK = 50;

/** An image to write again, and the notes that show it. */
export type Convertible = {
  attachmentId: string;
  /** The note it belongs to, which its copy belongs to as well. */
  noteId: string;
  bytes: number;
  mime: string;
  name: string;
  locked: boolean;
  /** Every note that shows it, as their devices last reported. */
  usedBy: string[];
};

export type Found = {
  files: Convertible[];
  bytes: number;
  /** Locked notes' files, whose type only the vault can tell: looked at once it is open. */
  waitingForVault: number;
};

/** How far a run has come. */
export type ConvertProgress = {
  total: number;
  done: number;
  converted: number;
  /** Written again but not smaller, or shown by nothing any more: left as they are. */
  kept: number;
  /** Could not be read or written; tried again next time. */
  failed: number;
  /** Of those converted: their size before, and their copies' after. */
  before: number;
  after: number;
};

/** Why a run stopped before the end. */
export type ConvertStop = "cancelled" | "offline" | "quota" | "unsent";

export type ConvertReport = ConvertProgress & { stopped: ConvertStop | null };

/**
 * The images worth writing again: PNG or JPEG, uploaded, and shown by at
 * least one note out of the trash. The server says which notes show each,
 * and the note each was added to says so itself.
 */
export async function findConvertible(client: ConvexReactClient): Promise<Found> {
  const database = db();
  const kept = new Set(await getMeta<string[]>(META.convertKept, []));
  const rows = await database.attachments
    .filter(
      (row) => row.status === "committed" && row.deletedAt === null && !kept.has(row.attachmentId),
    )
    .toArray();
  let waitingForVault = 0;
  const kinds: Omit<Convertible, "usedBy">[] = [];
  for (const row of rows) {
    let meta = row.locked ? null : { name: row.name ?? "", mime: row.mime ?? "" };
    if (row.locked) {
      if (!vault.isUnlocked) {
        waitingForVault += 1;
        continue;
      }
      meta = await sealedMeta(row).catch(() => null);
    }
    if (!meta || !CONVERTIBLE.has(meta.mime)) continue;
    kinds.push({
      attachmentId: row.attachmentId,
      noteId: row.noteId,
      bytes: row.bytes,
      mime: meta.mime,
      name: meta.name,
      locked: row.locked,
    });
  }

  const usedBy: Record<string, string[]> = {};
  for (let at = 0; at < kinds.length; at += PER_ASK) {
    const ids = kinds.slice(at, at + PER_ASK).map((kind) => kind.attachmentId);
    Object.assign(usedBy, await client.query(api.attachments.usedBy, { attachmentIds: ids }));
  }
  const live = new Set(
    (await database.notes.filter((note) => note.deletedAt === null && !note.purged).toArray()).map(
      (note) => note.noteId,
    ),
  );
  const files: Convertible[] = [];
  for (const kind of kinds) {
    const reported = usedBy[kind.attachmentId] ?? [];
    // What a note uses is told to the server only a while after it changes:
    // a note whose copy here is up to date says for itself, the one the
    // image was added to included, and one just changed, here, is right.
    const notes: string[] = [];
    for (const noteId of new Set([...reported, kind.noteId])) {
      if (!live.has(noteId)) continue;
      const here = await usesHere(noteId, kind.attachmentId);
      if (here ?? reported.includes(noteId)) notes.push(noteId);
    }
    if (notes.length === 0) continue;
    files.push({ ...kind, usedBy: notes });
  }
  return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), waitingForVault };
}

/**
 * Whether a note shows a file, as this device's copy of it says: null when
 * the copy cannot tell, being behind (or not here), or a locked note's with
 * the vault closed.
 */
async function usesHere(noteId: string, attachmentId: string): Promise<boolean | null> {
  const database = db();
  const [note, body] = await Promise.all([database.notes.get(noteId), database.bodies.get(noteId)]);
  if (!note || !body || body.keyEpoch !== note.keyEpoch || body.throughSeq < note.snapshotSeq)
    return null;
  if (note.locked && !vault.isUnlocked) return null;
  const refs = await withDetachedDoc(noteId, (doc) => attachmentRefs(doc)).catch(() => null);
  return refs ? refs.includes(attachmentId) : null;
}

/**
 * Writes each image again as WebP, one at a time, and puts the copy in its
 * place in every note that shows it once the server holds the copy: a copy
 * not clearly smaller is not kept. Stops, keeping what was done, when
 * `signal` aborts, the network goes, the account has no room for the next
 * copy, a copy does not reach the server in time, or this device has changes
 * still to send (a note it has not sent may show a file too, which the
 * server cannot know). The originals replaced are told to the server as the
 * run goes, each with its copy.
 */
export async function convertImages(opts: {
  client: ConvexReactClient;
  files: Convertible[];
  /** The account's figures: read for each image, as they move with each copy sent. */
  allowance: Allowance | null;
  /** Fetches notes' bodies this device does not have, as the sync engine does. */
  fetchBodies?: (noteIds: string[]) => Promise<void>;
  /** Has the sync engine send what is waiting now, a copy among it. */
  send?: () => void;
  /** Waits for a staged copy to be on the server: {@link untilStored}, but for tests. */
  upload?: (copyId: string) => Promise<Stored>;
  signal?: AbortSignal;
  onProgress?: (progress: ConvertProgress) => void;
}): Promise<ConvertReport> {
  const { client, files, signal } = opts;
  const report: ConvertReport = {
    total: files.length,
    done: 0,
    converted: 0,
    kept: 0,
    failed: 0,
    before: 0,
    after: 0,
    stopped: null,
  };
  const replaced: Replacement[] = [];
  const told = async () => {
    if (replaced.length === 0) return;
    await tellReplaced(client, replaced.splice(0));
  };
  try {
    await tellReplaced(client, []);
    if ((await db().outbox.count()) > 0) {
      report.stopped = "unsent";
      return report;
    }
    for (const file of files) {
      if (signal?.aborted) {
        report.stopped = "cancelled";
        break;
      }
      if (!navigator.onLine) {
        report.stopped = "offline";
        break;
      }
      const outcome = await convertOne(opts, file).catch((error: unknown) =>
        error instanceof AttachmentUnavailableError && error.reason === "offline"
          ? ("offline" as const)
          : ("failed" as const),
      );
      if (outcome === "offline" || outcome === "quota" || outcome === "cancelled") {
        report.stopped = outcome;
        break;
      }
      report.done += 1;
      if (outcome === "failed") report.failed += 1;
      else if (outcome === "kept") report.kept += 1;
      else {
        report.converted += 1;
        report.before += outcome.before;
        report.after += outcome.after;
        replaced.push({ original: file.attachmentId, copy: outcome.copy });
        if (replaced.length >= PER_ASK) await told();
      }
      opts.onProgress?.({ ...report });
    }
  } finally {
    await told();
  }
  return report;
}

type Outcome =
  | "kept"
  | "failed"
  | "quota"
  | "offline"
  | "cancelled"
  | { before: number; after: number; copy: string };

/** An original, and the copy the server holds that took its place. */
type Replacement = { original: string; copy: string };

/** What became of a staged copy: on the server, turned away by it, or not known in time. */
export type Stored = "committed" | "refused" | "offline" | "timeout" | "cancelled";

async function convertOne(
  opts: Parameters<typeof convertImages>[0],
  file: Convertible,
): Promise<Outcome> {
  const { client } = opts;
  if (file.locked && !vault.isUnlocked) return "failed";
  // Every note that shows it is here to put the copy in, or none gets it.
  const notes = await notesToRewrite(file, opts.fetchBodies);
  if (!notes) return "failed";
  if (notes.length === 0) return "kept";

  const original = await loadAttachmentBlob(client, file.attachmentId);
  // An animated PNG would keep only its first frame: left as it is, as a GIF is.
  if (file.mime === "image/png" && (await isAnimatedPng(original))) {
    await remember(file.attachmentId);
    return "kept";
  }
  const allowance = opts.allowance;
  const prepared = await prepareImage(
    new File([original], file.name || "image", { type: file.mime }),
    { maxBytes: allowance ? fileLimit(allowance, "image") : undefined },
  );
  if (prepared.mime === file.mime || prepared.blob.size >= original.size * KEEP_BELOW) {
    // Not offered again: written again, it comes to no less.
    await remember(file.attachmentId);
    return "kept";
  }
  if (allowance && !fitsAllowance(allowance, prepared.blob.size, await queuedBytes())) {
    return "quota";
  }

  const ref = await stageUpload({
    noteId: await ownerFor(file, notes),
    file: new File([prepared.blob], renamed(file.name, prepared.mime), { type: prepared.mime }),
    prepared,
    locked: file.locked,
  });
  const copy = idFromRef(ref)!;
  // On the server before any note points at it: a copy that never got there
  // (turned away, its reservation lapsed as the app was put away, the device
  // gone for good) would leave its notes showing nothing once the original
  // is deleted.
  opts.send?.();
  const stored = await (opts.upload ?? ((id: string) => untilStored(client, id, opts.signal)))(
    copy,
  );
  if (stored !== "committed") {
    await discardStaged(copy).catch(() => {});
    if (stored === "refused")
      return allowanceLeft(opts.allowance, prepared.blob.size) ? "failed" : "quota";
    return stored === "cancelled" ? "cancelled" : "offline";
  }

  let changed = 0;
  for (const noteId of notes) changed += await rewriteIn(noteId, file, ref);
  // Shown by nothing after all, the notes having changed meanwhile: the copy
  // is left to go as any unused file does.
  return changed === 0 ? "kept" : { before: original.size, after: prepared.blob.size, copy };
}

/** Whether the account's figures, as they are now, leave room for a file this size. */
function allowanceLeft(allowance: Allowance | null, bytes: number): boolean {
  return !allowance || fitsAllowance(allowance, bytes);
}

/**
 * The note a copy belongs to: the original's, when it is among the notes
 * rewritten and out of the trash, else the first of them that is. The
 * original's note may be in the trash, or purged with the image living on
 * in a note it was copied to, and the server takes no file for a purged
 * note, and deletes one on its way when its note is purged.
 */
async function ownerFor(file: Convertible, notes: string[]): Promise<string> {
  const rows = await db().notes.bulkGet(notes);
  const live = rows.flatMap((note) =>
    note && !note.purged && note.deletedAt === null ? [note.noteId] : [],
  );
  return live.includes(file.noteId) ? file.noteId : (live[0] ?? notes[0]!);
}

/** How long a copy may take to reach the server before the run stops. */
const STORE_TIMEOUT_MS = 120_000;
const STORE_POLL_MS = 1_000;

/**
 * Waits until the server holds a staged copy (the sync engine sends it, in
 * this tab or another), or has turned it away: `refused` once nothing of it
 * is left on the device to send and the server does not have it.
 */
export async function untilStored(
  client: ConvexReactClient,
  copyId: string,
  signal?: AbortSignal,
  { pollMs = STORE_POLL_MS, timeoutMs = STORE_TIMEOUT_MS } = {},
): Promise<Stored> {
  const database = db();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!navigator.onLine) return "offline";
    const [waiting, committing, urls] = await Promise.all([
      database.pendingUploads.get(copyId),
      database.outbox.filter((op) => op.entityId === copyId).count(),
      client.query(api.attachments.urls, { attachmentIds: [copyId] }),
    ]);
    if (urls[copyId]) return "committed";
    if (!waiting && committing === 0) return "refused";
    if (signal?.aborted) return "cancelled";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return "timeout";
}

/** An animated PNG: one with an animation control chunk before its image data. */
export async function isAnimatedPng(blob: Blob): Promise<boolean> {
  if (typeof blob.slice !== "function") return false;
  const head = new Uint8Array(await blob.slice(0, 1 << 16).arrayBuffer());
  const text = new TextDecoder("latin1").decode(head);
  const control = text.indexOf("acTL");
  return control !== -1 && (text.indexOf("IDAT") === -1 || control < text.indexOf("IDAT"));
}

/** Images written again that came to no less, or would lose their animation: not offered again. */
async function remember(attachmentId: string): Promise<void> {
  const kept = await getMeta<string[]>(META.convertKept, []);
  if (!kept.includes(attachmentId)) await setMeta(META.convertKept, [...kept, attachmentId]);
}

/**
 * The notes to put the copy in: those that show the file and are here, their
 * bodies fetched first where they are not. Null if one of them cannot be
 * had, so that no note is left showing the original the server is told was
 * replaced; a note locked unlike the file is left showing it (a copy made for
 * it lives on in its own lock).
 */
async function notesToRewrite(
  file: Convertible,
  fetchBodies: ((noteIds: string[]) => Promise<void>) | undefined,
): Promise<string[] | null> {
  const database = db();
  const notes = (await database.notes.bulkGet(file.usedBy)).filter(
    (note) => note && !note.purged && note.locked === file.locked,
  );
  const behind = async () => {
    const out: string[] = [];
    for (const note of notes) {
      const body = await database.bodies.get(note!.noteId);
      if (!body || body.keyEpoch !== note!.keyEpoch || body.throughSeq < note!.snapshotSeq) {
        out.push(note!.noteId);
      }
    }
    return out;
  };
  let missing = await behind();
  if (missing.length > 0 && fetchBodies) {
    await fetchBodies(missing).catch(() => {});
    missing = await behind();
  }
  if (missing.length > 0) return null;
  return notes.map((note) => note!.noteId);
}

/** Puts the copy in place of the file in one note's document: how many places changed. */
function rewriteIn(noteId: string, file: Convertible, ref: string): Promise<number> {
  return withRelockLock(
    noteId,
    true,
    async () => {
      // Read again right before the edit: a lock or unlock may have come meanwhile.
      const note = await db().notes.get(noteId);
      if (!note || note.purged || note.locked !== file.locked) return 0;
      if (note.locked && !vault.isUnlocked) return 0;
      const doc = await acquireDoc(noteId);
      try {
        const changed = rewriteRefInDoc(doc, refFor(file.attachmentId), ref);
        // In storage before the run goes on, as a lock's copies are.
        if (changed > 0) await flushDoc(noteId);
        return changed;
      } finally {
        await releaseDoc(noteId);
      }
    },
    () => 0,
  );
}

/** A file's name with the extension of what it is now: image.png, written as WebP, is image.webp. */
function renamed(name: string, mime: string): string {
  const extension = mime === "image/webp" ? "webp" : (mime.split("/")[1] ?? "");
  const stem = name.replace(/\.[^./]+$/, "") || "image";
  return extension ? `${stem}.${extension}` : stem;
}

/**
 * Tells the server these originals were replaced, each with the copy that
 * took its place, along with any a run could not tell it before (kept on the
 * device until it can): told nothing, the server would keep them thirty days
 * after they go unused rather than a week. The server checks each copy is
 * stored.
 */
async function tellReplaced(client: ConvexReactClient, replaced: Replacement[]): Promise<void> {
  const waiting = (await getMeta<unknown[]>(META.replacedToTell, [])).filter(
    (entry): entry is Replacement =>
      typeof entry === "object" && entry !== null && "original" in entry && "copy" in entry,
  );
  const seen = new Set<string>();
  const left = [...waiting, ...replaced].filter((entry) => {
    if (seen.has(entry.original)) return false;
    seen.add(entry.original);
    return true;
  });
  if (left.length === 0) return;
  try {
    while (left.length > 0) {
      const answer = await client.mutation(api.attachments.markReplaced, {
        replaced: left.slice(0, PER_ASK),
      });
      if (answer.status !== "ok") break;
      left.splice(0, PER_ASK);
    }
  } catch {
    // Offline, say: the next run tells it.
  }
  await setMeta(META.replacedToTell, left);
}
