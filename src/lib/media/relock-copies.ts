"use client";

import type { ConvexReactClient } from "convex/react";
import * as Y from "yjs";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { acquireDoc, flushDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import { attachmentRefs, bodyFragment } from "@/lib/sync/ydoc";
import type { Attachment, Folder, Note } from "@/lib/types";
import { lockCoverage, needsLock } from "@/lib/vault/model";
import {
  type Allowance,
  UPLOADABLE_FILE_TYPES,
  discardStaged,
  fitsAllowance,
  loadAttachmentBlob,
  queuedBytes,
  sealedMeta,
  stageUpload,
} from "./attachments";
import { UPLOADABLE_IMAGE_TYPES, categoryOf } from "./compress";
import { idFromRef, refFor } from "./ref";

/**
 * A locked note only encrypts its own files. An image copied in from another
 * note still belongs to that note, so it stays readable on the server however
 * locked this one is. These helpers give such a note its own encrypted copy
 * of every file it shows and point it there; the original is left to the note
 * it belongs to.
 *
 * Locking a note makes the copies first and seals a version of the note that
 * already points at them ({@link copiesForLock}). After that, the editor (for
 * files pasted into a locked note) and the repair pass (for whatever could
 * not be copied at the time) do the same for locked notes ({@link relockCopies}).
 *
 * The other way round, a note that is not locked cannot show another note's
 * encrypted file once the vault is closed: the file is only ever decrypted
 * inside this tab. While the vault is open, such a note is given its own
 * plaintext copy of the file and pointed there ({@link plainCopies}), by the
 * editor and the repair pass alike. The original stays encrypted with the
 * note it belongs to.
 */

/** What one pass over a note did. */
export type RelockOutcome = {
  /** Files the note now shows from a copy of its own. */
  copied: number;
  /** Files that could not be copied yet: offline, still uploading, or busy elsewhere. */
  pending: number;
  /** Files whose copy would not fit the allowance or the limit for one file, or was refused. */
  tooLarge: number;
  /** Of the files not copied, those the server holds readable. */
  readable: number;
};

const NONE: RelockOutcome = { copied: 0, pending: 0, tooLarge: 0, readable: 0 };
const BUSY: RelockOutcome = { copied: 0, pending: 1, tooLarge: 0, readable: 0 };

/** What encrypting a file adds to it: the GCM tag. */
const SEAL_OVERHEAD = 16;
/** How long to wait for the server to say whether it holds a file. */
const ASK_TIMEOUT_MS = 10_000;
/**
 * A file still being uploaded from another device when first seen is taken
 * for abandoned after this long, like the server's own reservations: its
 * bytes will never exist, so nothing readable can be left behind.
 */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;
const unavailableSince = new Map<string, number>();
/** Files the server said it does not hold: not asked about again this session. */
const gone = new Set<string>();

/** Forgets what this session learned about other notes' files: for tests. */
export function forgetRelockState(): void {
  gone.clear();
  unavailableSince.clear();
}

/** A file whose copy was refused is not copied again for this long. */
const REFUSED_RETRY_MS = 10 * 60 * 1000;
/** How long a refusal is remembered, for an edit that still shows the copy. */
const REFUSALS_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/** A copy the server refused, for the note it was made for. */
type RefusedCopy = { noteId: string; originalId: string; reason: string; at: number };

/** Pointing every reference to one file at another, both as references. */
type Swap = { from: string; to: string };

/**
 * Points every reference to `from` in a note's document at `to`: block props
 * such as an image's url, and text marks such as a link. One transaction, so
 * the edit is one change to sync. Returns how many places changed.
 *
 * Written to the document directly rather than through the editor, so it is
 * not an undo step: undoing it would only bring the other note's file back.
 */
export function rewriteRefInDoc(doc: Y.Doc, from: string, to: string): number {
  let changed = 0;
  const swap = (value: unknown): unknown => {
    if (value === from) return to;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    let touched = false;
    const next: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      next[key] = swap(inner);
      if (next[key] !== inner) touched = true;
    }
    return touched ? next : value;
  };
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.AbstractType<unknown>) => {
    if (node instanceof Y.XmlText) {
      let index = 0;
      const delta = node.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[];
      for (const op of delta) {
        const length = typeof op.insert === "string" ? op.insert.length : 1;
        if (op.attributes) {
          const next = swap(op.attributes) as Record<string, unknown>;
          if (next !== op.attributes) {
            node.format(index, length, next);
            changed += 1;
          }
        }
        index += length;
      }
      return;
    }
    if (node instanceof Y.XmlElement) {
      for (const [key, value] of Object.entries(node.getAttributes())) {
        if (value === from) {
          node.setAttribute(key, to);
          changed += 1;
        }
      }
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
    }
  };
  doc.transact(() => walk(bodyFragment(doc)));
  return changed;
}

/**
 * The document's state with every swap made, and the files it now points at
 * that it did not before: what a lock seals. The document itself is left as
 * it is.
 */
export function withSwaps(doc: Y.Doc, swaps: Swap[]): { state: Uint8Array; used: Set<string> } {
  const state = Y.encodeStateAsUpdate(doc);
  const used = new Set<string>();
  if (swaps.length === 0) return { state, used };
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, state);
    copy.transact(() => {
      for (const swap of swaps) {
        if (rewriteRefInDoc(copy, swap.from, swap.to) > 0) used.add(idFromRef(swap.to)!);
      }
    });
    return { state: Y.encodeStateAsUpdate(copy), used };
  } finally {
    copy.destroy();
  }
}

/**
 * Whether the server holds each file, by asking for its download URL: it
 * gives one only for a stored file of this account. `null` when it could not
 * be asked.
 */
async function serverHolds(
  client: ConvexReactClient,
  attachmentIds: string[],
): Promise<Map<string, boolean> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const urls = await Promise.race([
      client.query(api.attachments.urls, { attachmentIds: attachmentIds.slice(0, 64) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ASK_TIMEOUT_MS);
      }),
    ]);
    return new Map(attachmentIds.map((id) => [id, Boolean(urls[id])]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refusedCopies(): Promise<Record<string, RefusedCopy>> {
  return getMeta<Record<string, RefusedCopy>>(META.refusedCopies, {});
}

/**
 * Remembers a copy the server refused, and the file it copied: whatever still
 * shows the copy is pointed back at the original, and the original is not
 * copied again for a while. Called before the copy's rows are removed.
 */
export async function recordRefusedCopy(
  copyId: string,
  entry: Omit<RefusedCopy, "at">,
): Promise<void> {
  const database = db();
  await database.transaction("rw", database.meta, async () => {
    const now = Date.now();
    const kept = Object.entries(await refusedCopies()).filter(
      ([, old]) => now - old.at < REFUSALS_KEPT_MS,
    );
    await setMeta(META.refusedCopies, {
      ...Object.fromEntries(kept),
      [copyId]: { ...entry, at: now },
    });
  });
}

/** A file the note shows that another note uploaded, and what to do with it. */
type Foreign = { row: Attachment } | { unknown: string };

/**
 * The files a note shows that belong to another note. A file another locked
 * note owns counts too: unlocking that note would turn it back to plaintext
 * under this one. A file this device has no row for yet counts as unknown.
 */
export async function foreignFiles(noteId: string, attachmentIds: string[]): Promise<Foreign[]> {
  if (attachmentIds.length === 0) return [];
  const rows = await db().attachments.bulkGet(attachmentIds);
  const found: Foreign[] = [];
  rows.forEach((row, index) => {
    if (!row) found.push({ unknown: attachmentIds[index]! });
    else if (row.deletedAt === null && row.noteId !== noteId) found.push({ row });
  });
  return found;
}

/**
 * Runs `run` as the only pass over a note, across tabs too: the lock, the
 * editor and the repair pass would otherwise each copy the same file. `wait`
 * waits its turn; otherwise `busy` answers at once.
 */
export async function withRelockLock<T>(
  noteId: string,
  wait: boolean,
  run: () => Promise<T>,
  busy: () => T,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return run();
  return navigator.locks.request(`memoca-relock:${noteId}`, { ifAvailable: !wait }, (lock) =>
    lock ? run() : busy(),
  );
}

/** What {@link planCopies} staged, and what to point where. */
type Plan = {
  /** From each foreign file to its new copy. */
  copies: Swap[];
  /** From each refused copy the note still shows back to its original. */
  restores: Swap[];
  outcome: RelockOutcome;
};

/** The types a note that is not locked can hold: what the server takes in plaintext. */
const PLAIN_TYPES: readonly string[] = [...UPLOADABLE_IMAGE_TYPES, ...UPLOADABLE_FILE_TYPES];

/**
 * Stages a copy of every file the note shows that another note owns, where
 * it can, and works out what to point where. The note itself is not touched.
 *
 * For a locked note the copies are encrypted, and every other note's file is
 * copied. With `plain`, for a note that is not locked, the copies are
 * plaintext, and only files kept encrypted are copied: a plain file already
 * shows wherever it is pasted.
 */
async function planCopies(
  client: ConvexReactClient,
  noteId: string,
  shownIds: string[],
  allowance: Allowance | null,
  { forLock = false, plain = false }: { forLock?: boolean; plain?: boolean } = {},
): Promise<Plan> {
  const database = db();
  const outcome = { ...NONE };
  const refused = await refusedCopies();
  const now = Date.now();

  const restores: Swap[] = [];
  const shown = new Set<string>();
  for (const id of shownIds) {
    const refusal = refused[id];
    if (refusal?.noteId === noteId) {
      restores.push({ from: refFor(id), to: refFor(refusal.originalId) });
      shown.add(refusal.originalId);
    } else {
      shown.add(id);
    }
  }
  const foreign = await foreignFiles(noteId, [...shown]);

  // A file this device has not heard of yet may be one the server holds:
  // copied later, once its row has arrived. Only a locked note asks now: for
  // a plain one, only the row can say whether the file is encrypted at all.
  const unknown = plain
    ? []
    : foreign.flatMap((file) =>
        "unknown" in file && !gone.has(file.unknown) ? [file.unknown] : [],
      );
  if (unknown.length > 0) {
    const held = await serverHolds(client, unknown);
    for (const id of unknown) {
      if (held !== null && !held.get(id)) {
        gone.add(id);
      } else {
        outcome.pending += 1;
        outcome.readable += 1;
      }
    }
  }

  const figures = allowance ?? (await getMeta<Allowance | null>(META.profile, null));
  let queued = await queuedBytes();
  // What a copy adds to the file it is made from: encryption adds its tag.
  const added = plain ? 0 : SEAL_OVERHEAD;
  const copies: Swap[] = [];
  try {
    for (const file of foreign) {
      if (!("row" in file) || gone.has(file.row.attachmentId)) continue;
      const { row } = file;
      if (plain) {
        // A plain file shows here as it is.
        if (!row.locked) continue;
      } else if (!row.locked && (await database.notes.get(row.noteId))?.locked === true) {
        // Marked plain while the note it belongs to is locked: sealed
        // elsewhere and not heard of here yet, or about to be sealed by the
        // repair pass. What the server holds may already be ciphertext, so
        // it waits.
        outcome.pending += 1;
        continue;
      }
      const leave = (why: "pending" | "tooLarge") => {
        outcome[why] += 1;
        if (!row.locked) outcome.readable += 1;
      };
      const refusal = Object.values(refused).find(
        (entry) =>
          entry.noteId === noteId &&
          entry.originalId === row.attachmentId &&
          now - entry.at < REFUSED_RETRY_MS,
      );
      if (refusal) {
        leave("tooLarge");
        continue;
      }
      // An encrypted file's name and type are sealed with it, and a plain
      // copy takes them over. It has to be of a type a plain note can hold:
      // one only a locked note takes, such as a Word file, is not copied out.
      const meta = plain ? await sealedMeta(row).catch(() => null) : null;
      if (meta && !PLAIN_TYPES.includes(meta.mime)) continue;
      const known = row.mime ?? meta?.mime ?? null;
      // A file only the vault can describe has no known type until it is
      // read, so until then it is held only to the looser limit.
      const fits = (bytes: number, mime: string | null) =>
        !figures ||
        fitsAllowance(figures, bytes + added, queued, mime === null ? "video" : categoryOf(mime));
      // Before downloading anything: the row knows the size. A stored
      // encrypted file's is its ciphertext's, the tag longer than its
      // plaintext.
      const size = plain ? Math.max(0, row.bytes - SEAL_OVERHEAD) : row.bytes;
      if (!fits(size, known)) {
        leave("tooLarge");
        continue;
      }
      const loaded = await load(client, row);
      if (loaded === "gone") {
        gone.add(row.attachmentId);
        continue;
      }
      if (loaded === "pending") {
        leave("pending");
        continue;
      }
      // Longer than the plain file the row describes: sealed elsewhere since
      // (encryption adds its tag), and neither the file's row nor its note's
      // has reached this device yet. Copied once they have.
      if (!row.locked && loaded.size !== row.bytes) {
        leave("pending");
        continue;
      }
      const mime = known ?? (loaded.type || "application/octet-stream");
      if (plain && !PLAIN_TYPES.includes(mime)) continue;
      if (!fits(loaded.size, mime)) {
        leave("tooLarge");
        continue;
      }
      const name = row.name ?? meta?.name ?? (mime.startsWith("image/") ? "image" : "file");
      const ref = await stageUpload({
        noteId,
        file: new File([loaded], name, { type: mime }),
        locked: !plain,
        prepared: { blob: loaded, mime, width: row.width ?? 0, height: row.height ?? 0 },
        copyOf: row.attachmentId,
        // A plaintext copy is not sent until the note points at it: one sent
        // for a pass that then stops would be decrypted bytes on the server
        // that nothing shows.
        heldForLock: forLock || plain,
      });
      queued += loaded.size + added;
      copies.push({ from: refFor(row.attachmentId), to: ref });
    }
  } catch (error) {
    // Nobody will point at what was staged before the failure.
    for (const copy of copies) await discardStaged(idFromRef(copy.to)!).catch(() => {});
    throw error;
  }
  return { copies, restores, outcome };
}

/**
 * Gives a locked note its own encrypted copy of every file it shows that
 * belongs to another note, and points the note at the copies; points it back
 * at the original of any copy the server refused. Does nothing for a note
 * that is not locked (the lock makes its copies) or with the vault closed.
 *
 * One pass per note at a time, across tabs too: `wait` waits for another
 * pass to finish instead of reporting the note busy. `allowance` is the
 * account's current figures when known, else the last ones this device saw.
 */
export async function relockCopies(
  client: ConvexReactClient,
  noteId: string,
  opts: { allowance?: Allowance | null; wait?: boolean } = {},
): Promise<RelockOutcome> {
  return withRelockLock(
    noteId,
    opts.wait === true,
    () => copyOnce(client, noteId, opts.allowance ?? null, false),
    () => BUSY,
  );
}

/**
 * Gives a note that is not locked its own plaintext copy of every file it
 * shows that belongs to another note and is kept encrypted, and points the
 * note at the copies: the original can only be shown with the vault open.
 * Points it back at the original of any copy the server refused. Does
 * nothing for a locked note, which is never given a plaintext copy, or with
 * the vault closed, when nothing can be decrypted: it is done next time.
 *
 * Takes the same turn per note as {@link relockCopies}, and the same options.
 */
export async function plainCopies(
  client: ConvexReactClient,
  noteId: string,
  opts: { allowance?: Allowance | null; wait?: boolean } = {},
): Promise<RelockOutcome> {
  return withRelockLock(
    noteId,
    opts.wait === true,
    () => copyOnce(client, noteId, opts.allowance ?? null, true),
    () => BUSY,
  );
}

/**
 * Whether a note is given copies in a pass: encrypted ones if it is locked;
 * with `plain`, plaintext ones if it is not, is not in the trash (where
 * they would only take room), and is not in a locked folder, where it is
 * about to be locked and is kept from gaining plaintext meanwhile.
 */
function wanted(note: Note, folders: Folder[], plain: boolean): boolean {
  if (note.purged) return false;
  if (!plain) return note.locked;
  return !note.locked && note.deletedAt === null && !needsLock(note, lockCoverage(folders));
}

/** One pass over a note: encrypted copies for a locked note, or `plain` ones for a note that is not. */
async function copyOnce(
  client: ConvexReactClient,
  noteId: string,
  allowance: Allowance | null,
  plain: boolean,
): Promise<RelockOutcome> {
  // Not held open: a background pass must not keep the vault from closing.
  // Every step below either needs no key or checks for one first.
  if (!vault.isUnlocked) return NONE;
  const database = db();
  const [note, folders] = await Promise.all([
    database.notes.get(noteId),
    database.folders.toArray(),
  ]);
  if (!note || !wanted(note, folders, plain)) return NONE;
  const ids = await withDetachedDoc(noteId, (doc) => attachmentRefs(doc));
  // Read without its key, a locked note comes out empty: nothing to go on.
  if (!vault.isUnlocked || ids.length === 0) return NONE;

  const plan = await planCopies(client, noteId, ids, allowance, { plain });
  // Copies staged but not pointed at: taken back at the end.
  const unused = new Set(plan.copies.map((copy) => idFromRef(copy.to)!));
  try {
    if (plan.copies.length === 0 && plan.restores.length === 0) return plan.outcome;
    const doc = await acquireDoc(noteId);
    try {
      // Read again with the document open, and nothing awaited from here to
      // the edit: an unlock may have finished while the files were read, and
      // a plain note must not point at copies only the vault can show; or a
      // lock, and a locked note must not point at a plaintext copy.
      const [now, foldersNow] = await Promise.all([
        database.notes.get(noteId),
        database.folders.toArray(),
      ]);
      if (!now || !wanted(now, foldersNow, plain) || !vault.isUnlocked) {
        plan.outcome.pending += plan.copies.length;
        return plan.outcome;
      }
      doc.transact(() => {
        for (const swap of plan.restores) rewriteRefInDoc(doc, swap.from, swap.to);
        for (const copy of plan.copies) {
          if (rewriteRefInDoc(doc, copy.from, copy.to) > 0) {
            plan.outcome.copied += 1;
            unused.delete(idFromRef(copy.to)!);
          }
        }
      });
      // In storage before the pass ends: another tab reads it from there, and
      // so does the upload of a copy the server then refuses.
      await flushDoc(noteId);
      // Plaintext copies go up once the note points at them.
      if (plain) {
        await releaseHeldCopies(
          plan.copies.map((copy) => idFromRef(copy.to)!).filter((id) => !unused.has(id)),
        );
      }
      // Refused while the other files were being read: back at once.
      const refused = await refusedCopies();
      const late = plan.copies.filter((copy) => {
        const id = idFromRef(copy.to)!;
        return !unused.has(id) && refused[id] !== undefined;
      });
      if (late.length > 0) {
        doc.transact(() => {
          for (const copy of late) rewriteRefInDoc(doc, copy.to, copy.from);
        });
        await flushDoc(noteId);
        plan.outcome.copied -= late.length;
        plan.outcome.tooLarge += late.length;
      }
    } finally {
      await releaseDoc(noteId);
    }
    return plan.outcome;
  } finally {
    // The block went while the file was being read, or the note changed.
    for (const id of unused) await discardStaged(id).catch(() => {});
  }
}

/**
 * For a note about to be locked: stages an encrypted copy of each file it
 * shows that another note owns, and returns the swaps for the version the
 * lock seals. The note itself is not changed, so nothing about the copies
 * reaches the server readable, and a lock that does not go through leaves the
 * note as it was. The copies are held back until then ({@link
 * releaseHeldCopies}), so none can be sent, or refused, for a lock that does
 * not happen. `left` is how many of the files not copied the server holds
 * readable. To be called inside {@link withRelockLock}, with the vault open.
 */
export async function copiesForLock(
  client: ConvexReactClient,
  noteId: string,
): Promise<{ swaps: Swap[]; staged: string[]; left: number }> {
  const ids = await withDetachedDoc(noteId, (doc) => attachmentRefs(doc));
  const plan = await planCopies(client, noteId, ids, null, { forLock: true });
  return {
    swaps: [...plan.restores, ...plan.copies],
    staged: plan.copies.map((copy) => idFromRef(copy.to)!),
    left: plan.outcome.readable,
  };
}

/** Lets copies a lock held back go up, now that the note is locked. */
export async function releaseHeldCopies(attachmentIds: string[]): Promise<void> {
  const database = db();
  for (const id of attachmentIds) await database.pendingUploads.update(id, { heldForLock: false });
}

/** How long after a held copy was made this device must have synced before it is taken back. */
const HELD_SETTLE_MS = 10 * 60 * 1000;

/**
 * Copies a lock held back and never let go of, because the tab went away
 * part way. Let go once the note turns out locked (the lock went through
 * after all); taken back once it is certain it did not: this device has
 * caught up with the server well after the copy was made, and no lock of the
 * note is under way. `sync` is where syncing stands, when known.
 */
export async function settleHeldCopies(
  sync: { catchingUp: boolean; lastSyncAt: number | null } | null,
): Promise<number> {
  const database = db();
  const held = await database.pendingUploads.filter((row) => row.heldForLock === true).toArray();
  let settled = 0;
  for (const row of held) {
    await withRelockLock(
      row.noteId,
      false,
      async () => {
        const note = await database.notes.get(row.noteId);
        if (note?.locked && !note.purged) {
          await releaseHeldCopies([row.attachmentId]);
          settled += 1;
          return;
        }
        const caughtUp =
          sync !== null &&
          !sync.catchingUp &&
          sync.lastSyncAt !== null &&
          sync.lastSyncAt > row.createdAt + HELD_SETTLE_MS;
        if (!note || note.purged || caughtUp) {
          await discardStaged(row.attachmentId);
          settled += 1;
        }
      },
      () => undefined,
    );
  }
  return settled;
}

/**
 * The file's bytes, or why there are none: `gone` when the server holds no
 * such file, so nothing readable is left to protect; `pending` when it might
 * and they could not be had now.
 */
async function load(
  client: ConvexReactClient,
  row: Attachment,
): Promise<Blob | "gone" | "pending"> {
  try {
    const blob = await loadAttachmentBlob(client, row.attachmentId);
    unavailableSince.delete(row.attachmentId);
    return blob;
  } catch {
    // A failed download says nothing about whether the file exists: ask.
    const held = await serverHolds(client, [row.attachmentId]);
    if (held === null || held.get(row.attachmentId)) return "pending";
    if (row.status === "committed") return "gone";
    // Still being uploaded from another device, or abandoned there.
    const since = unavailableSince.get(row.attachmentId) ?? Date.now();
    unavailableSince.set(row.attachmentId, since);
    return Date.now() - since > ABANDONED_AFTER_MS ? "gone" : "pending";
  }
}

/**
 * Points a note back at the file it had copied, when the server refused the
 * copy: better the other note's file than one that will never exist. What
 * this cannot reach (an edit not saved yet, another tab, a note that needs
 * the vault) the next pass puts right, from {@link recordRefusedCopy}.
 */
export async function restoreOriginal(
  noteId: string,
  copyId: string,
  originalId: string,
): Promise<void> {
  const note = await db().notes.get(noteId);
  if (!note || note.purged || (note.locked && !vault.isUnlocked)) return;
  const doc = await acquireDoc(noteId);
  try {
    if (rewriteRefInDoc(doc, refFor(copyId), refFor(originalId)) > 0) await flushDoc(noteId);
  } finally {
    await releaseDoc(noteId);
  }
}
