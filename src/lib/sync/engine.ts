"use client";

import type { ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { Stamp } from "@/lib/types";
import * as Y from "yjs";
import { api } from "@convex/_generated/api";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { open, seal } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import { type LocalUpdate, type OutboxEntry, db, getMeta, resetLocalData, setMeta } from "@/lib/db";
import { META, deviceId as ensureDeviceId } from "@/lib/db/meta";
import { type PullBatch, applyBatch } from "./apply";
import { loadClock, syncClock } from "./clock";
import { onAlert } from "./alerts";
import { restampOp } from "./restamp";
import { onOutboxChanged } from "./signal";
import { editsOutOfOutbox, enqueue } from "./outbox";
import { tellPeers } from "./peers";
import {
  applyRemote,
  flushAll,
  migrateOpenDoc,
  reloadDoc,
  withDetachedDoc,
  withDocFromStorage,
} from "./docs";
import { sameStatus } from "./status-store";
import { extractText, firstLine } from "./ydoc";
import { linkTargets } from "@/lib/note-links";

/** Bytes of operations to send in one push. The server accepts up to 4 MiB. */
const PUSH_BYTE_BUDGET = 1_000_000;
const PUSH_OP_LIMIT = 50;
/** Poll cadence while another device is actively editing. */
const FAST_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
/** At most this often a push for edits just queued, while they keep coming (kickPaced). */
export const PUSH_EVERY_MS = 1_200;
/** How long an edit refused for want of room waits before it is sent again. */
const QUOTA_RETRY_MS = 60_000;
/**
 * How long a note whose refused edits could not be sent again, once its body
 * had been asked for, waits before the server is asked again: doubled each
 * time, up to the ceiling.
 */
const REBASE_RETRY_MS = 5_000;
const REBASE_RETRY_MAX_MS = 5 * 60_000;
/** Bodies fetched per round when catching up. */
const BODY_BATCH = 30;
/** Folders, and notes, asked about per call when looking for ones the server has let go of. */
const GHOST_BATCH = 200;
/** Notes whose bodies are pulled eagerly after the first sync. */
const PREFETCH_LIMIT = 200;
/**
 * A device offline longer than the server's tombstone window can no longer
 * learn about deletions incrementally, so it starts over.
 */
const FULL_RESYNC_AFTER_MS = 60 * 24 * 60 * 60 * 1000;

/** The Web Lock held by the window of the app that syncs. */
const LOCK_NAME = "memoca-sync";

/** Whether this window is in view: on the screen, not put away or in a tab behind. */
const inView = () => typeof document !== "undefined" && document.visibilityState === "visible";

type RemoteBody = FunctionReturnType<typeof api.notes.getBodies>["bodies"][number];

export type SyncStatus = {
  state: "idle" | "syncing" | "offline" | "error";
  pending: number;
  lastSyncAt: number | null;
  catchingUp: boolean;
  /** Edits are waiting for room: the account is full, and they are not saved on the server. */
  quotaFull: boolean;
  /**
   * Edits of a locked note, refused for the key it was locked with since,
   * wait here for the vault to be opened: they are not saved on the server.
   */
  heldForVault: boolean;
  /**
   * Edits the server would not take at all (an argument it refuses, a row
   * too large to store), set aside after a few tries so the rest can go:
   * how many. Sent again on request (retryStuck).
   */
  stuck: number;
  /** A file the server refused (too large, or no room): dropped, and the note shows nothing for it. */
  uploadRefused: boolean;
  /** An edit could not be stored on this device, and is held in memory until one can. */
  saveFailed: boolean;
};

/** Tries an op the server throws on gets before it is set aside. */
const STUCK_AFTER = 3;
/** How long after a compaction failed or was refused before the note is tried again. */
const COMPACT_RETRY_MS = 60_000;
/** Why the server would not take a file's commit when the file is to go up again from the start. */
const UPLOAD_AGAIN = new Set(["reservationExpired", "missingUpload", "largerThanReserved", "storageInUse"]);
/** How long an edit to a note the server does not have yet waits before it is sent again, and how often. */
const UNKNOWN_NOTE_RETRY_MS = 2_000;
const UNKNOWN_NOTE_TRIES = 20;

type PushResponse = FunctionReturnType<typeof api.sync.push>;

type Listener = (status: SyncStatus) => void;

export class SyncEngine {
  private device = "";
  private stopped = true;
  private leader = false;
  private releaseLock: (() => void) | null = null;
  /** Which ask for the sync lock is this window's own now: an older one, granted later, is let go at once. */
  private claim = 0;
  /** The page is going away (pagehide): the lock let go, and not asked for again until it comes back. */
  private leaving = false;
  private unwatch: (() => void) | null = null;
  private unwatchOutbox: (() => void) | null = null;
  private unwatchVault: (() => void) | null = null;
  private unwatchAlerts: (() => void) | null = null;
  private lastRefsPass = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval = IDLE_INTERVAL_MS;
  /** Where the pull subscription starts from, and which subscription is the current one. */
  private since = 0;
  private watching = 0;
  /** Batches are taken in one at a time, in the order they came. */
  private receiving: Promise<void> = Promise.resolve();
  private draining = false;
  /** Asked for while a push was under way: another follows it at once. */
  private again = false;
  /** Edits queued while a push was under way: pushed as paced once it ends (kickPaced). */
  private againPaced = false;
  /**
   * When edits were last sent, for pacing the pushes edits being typed ask
   * for: not a round that found nothing to send, after which the first edit
   * goes in a quarter of a second, as it did.
   */
  private sentAt = 0;
  private checkingGhosts = false;
  /** Whether every note's name has been settled since this engine started (see receive). */
  private settledTitles = false;
  private listeners = new Set<Listener>();
  private status: SyncStatus = {
    state: "idle",
    pending: 0,
    lastSyncAt: null,
    catchingUp: false,
    quotaFull: false,
    heldForVault: false,
    stuck: 0,
    uploadRefused: false,
    saveFailed: false,
  };
  /** A note being compacted, by its id: asked again meanwhile, the same attempt. */
  private compacting = new Map<string, Promise<boolean>>();
  /** When a note's compaction last failed or was refused, by its id. */
  private compactFailedAt = new Map<string, number>();
  /** Notes whose refused edits could not be sent again after asking for their body. */
  private rebaseWaits = new Map<string, { epoch: number; tries: number; at: number }>();

  constructor(private client: ConvexReactClient) {}

  /** Where syncing stands right now. */
  get current(): SyncStatus {
    return this.status;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // The first value arrives on a microtask rather than synchronously, so a
    // React subscriber does not set state during its own effect.
    queueMicrotask(() => {
      if (this.listeners.has(listener)) listener(this.status);
    });
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<SyncStatus>) {
    const next = { ...this.status, ...patch };
    // Nothing new to say (the outbox counted at 0 again, say): nobody is told.
    if (sameStatus(this.status, next)) return;
    this.status = next;
    for (const listener of this.listeners) listener(this.status);
  }

  /**
   * @param userKey identifies the signed-in account. Local data belonging to a
   * different account is wiped rather than merged, so a shared browser never
   * shows one person's notes to another.
   */
  async start(userKey: string): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;

    const previous = await getMeta<string | null>(META.userKey, null);
    if (previous && previous !== userKey) await resetLocalData();
    await setMeta(META.userKey, userKey);

    this.device = await ensureDeviceId();
    await loadClock();

    const lastSyncAt = await getMeta<number | null>(META.lastSyncAt, null);
    this.set({ lastSyncAt });
    if (lastSyncAt && Date.now() - lastSyncAt > FULL_RESYNC_AFTER_MS) {
      await setMeta(META.cursor, 0);
      await setMeta(META.ghostsChecked, false);
    }
    if (!(await getMeta<boolean>(META.pinPlacesPulled, false))) {
      await setMeta(META.cursor, 0);
      await setMeta(META.pinPlacesPulled, true);
    }

    // A window opened in view syncs itself, rather than waiting on one out
    // of sight (see claimLeadership).
    this.claimLeadership(inView());
    this.attachWindowHooks();
    this.unwatchOutbox = onOutboxChanged(() => this.kickPaced());
    // Edits of a locked note refused while the vault was closed go once it
    // opens (rebaseRefused), not at the next round.
    this.unwatchVault = vault.subscribe((unlocked) => {
      if (unlocked) this.kick(0);
    });
    // An edit that could not be stored here is said, until one is again.
    this.unwatchAlerts = onAlert((alert) => this.set({ saveFailed: alert === "saveFailed" }));
    this.set({ stuck: await this.stuckCount() });
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unwatchOutbox?.();
    this.unwatchOutbox = null;
    this.unwatchVault?.();
    this.unwatchVault = null;
    this.unwatchAlerts?.();
    this.unwatchAlerts = null;
    this.rebaseWaits.clear();
    this.claim += 1;
    this.releaseLock?.();
    this.releaseLock = null;
    this.leader = false;
    this.detachWindowHooks();
  }

  /**
   * Only one window syncs. The others still read and write the same local
   * database, so their UI stays live; they just do not open a second
   * subscription or race on the outbox.
   *
   * The one in view takes it (`take`): as it opens, and each time it comes
   * into view, from one out of sight. A window out of sight may not be
   * running at all: the desktop app's are suspended by WebKit a few minutes
   * after they are put away, the quick note's mostly so, and it is often the
   * one that syncs, being made first. Then the window looked at showed
   * nothing another device had changed (nor sent what was typed in it) until
   * the quick note was brought out. The one it is taken from steps down, and
   * waits in line to sync again once this one lets go.
   */
  private claimLeadership(take = false): void {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) {
      this.leader = true;
      void this.run();
      return;
    }
    // An ask already in line, if one is, is not taken back (no `signal`:
    // WebKit could hang a reload of a page holding a lock asked for with
    // one): granted later, it is let go at once, being an older claim.
    const claim = ++this.claim;
    const options: LockOptions = take ? { mode: "exclusive", steal: true } : { mode: "exclusive" };
    locks
      .request(LOCK_NAME, options, () => {
        if (this.stopped || this.leaving || claim !== this.claim) return Promise.resolve();
        this.leader = true;
        void this.run();
        return new Promise<void>((resolve) => {
          this.releaseLock = resolve;
        });
      })
      .catch(() => {
        // An older claim, the engine stopped, or the page going away: nothing to do.
        if (this.stopped || this.leaving || claim !== this.claim) return;
        // Taken by another window that came into view: it syncs now.
        this.stepDown();
        this.claimLeadership();
      });
  }

  /**
   * The page is going away (a reload, another page, the window closed): the
   * lock let go now, while it still can be, and not asked for again. Held
   * through the unload, or asked for again as another window took it, it
   * hung the reload in WebKit (Safari, the Mac app's window), every time.
   */
  private letGo(): void {
    this.leaving = true;
    this.claim += 1;
    this.stepDown();
  }

  /** No longer the window that syncs: what it was doing as that stops. */
  private stepDown(): void {
    this.leader = false;
    this.releaseLock?.();
    this.releaseLock = null;
    this.unwatch?.();
    this.unwatch = null;
    // What the subscription let go of still brings is not taken in.
    this.watching += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
  }

  private onOnline = () => this.kick(0);
  private onVisibility = () => {
    if (document.visibilityState === "hidden") void this.sendBeforeHidden();
    else if (!this.leader && !this.stopped && !this.leaving) this.claimLeadership(true);
    else this.kick(0);
  };
  private onPageHide = () => {
    const leading = this.leader;
    // Let go at once, before anything is awaited (see letGo); what was just
    // typed is still sent, by this page as it goes, if it was the one that
    // syncs. Sent twice (the next page sends it too) is the same as once.
    this.letGo();
    void this.sendBeforeHidden(leading);
  };
  /** Back from the back-forward cache: syncs again, as a page opened. */
  private onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted || this.stopped) return;
    this.leaving = false;
    if (!this.leader) this.claimLeadership(inView());
  };

  /**
   * What is typed, written and sent at once as the app is put away: a phone
   * suspends it soon after, and anything still waiting goes only once it is
   * opened again. Written first: sent alongside, the push could look at the
   * outbox before the last words were in it.
   */
  private async sendBeforeHidden(leaving = false): Promise<void> {
    await flushAll().catch(() => {});
    // Going away, the lock let go already: sent all the same, by the page
    // that was syncing, once.
    if (leaving) {
      if (!this.stopped) await this.drain(true);
      return;
    }
    if (!this.leader || this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.drain();
  }

  private attachWindowHooks() {
    if (typeof window === "undefined") return;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private detachWindowHooks() {
    if (typeof window === "undefined") return;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  /**
   * Asks for a push for edits just queued: in a quarter of a second, but
   * not sooner than PUSH_EVERY_MS after the last push began. A note being
   * typed in queues its edits twice a second, and each push, beyond what it
   * sends, has the outbox counted and the lists that show it run again, and
   * the server's echo taken in; those, while typing, made every key slower.
   * Its edits still reach the other devices within a second or two.
   */
  private kickPaced(): void {
    if (!this.leader || this.stopped) return;
    if (this.draining) {
      this.againPaced = true;
      return;
    }
    this.kick(Math.max(250, this.sentAt + PUSH_EVERY_MS - Date.now()));
  }

  /** Asks for a push sooner than the current cadence would. */
  kick(delay = 200): void {
    if (!this.leader || this.stopped) return;
    // The push under way may have read the outbox already: what was just
    // added goes in another straight after it, not at the next round (up to
    // five seconds later), where the end of that push would put it.
    if (this.draining) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), delay);
  }

  private async run(): Promise<void> {
    await this.resubscribe();
    await this.drain();
  }

  private async resubscribe(): Promise<void> {
    // Not once another window syncs: a batch still being taken in asks for
    // it again, as it ends.
    if (this.stopped || !this.leader) return;
    this.unwatch?.();
    const since = await getMeta<number>(META.cursor, 0);
    this.since = since;
    const watching = ++this.watching;
    const watch = this.client.watchQuery(api.sync.pull, { since, deviceId: this.device });

    const consume = () => {
      try {
        const result = watch.localQueryResult();
        // `null` means the server does not recognise this client yet, which is
        // normal for the moment between page load and the token attaching.
        if (!result) return;
        this.receiving = this.receiving
          .then(() =>
            // One that has been let go of meanwhile, from where this device
            // has since moved on, is not taken in again.
            watching === this.watching ? this.receive(result) : undefined,
          )
          // One that fails leaves the next to be taken in all the same.
          .catch(() => this.set({ state: "error" }));
      } catch {
        this.set({ state: "error" });
        // Re-subscribe rather than leaving a dead subscription behind.
        if (!this.stopped) setTimeout(() => void this.resubscribe(), 2_000);
      }
    };

    this.unwatch = watch.onUpdate(consume);
    consume();
  }

  private async receive(batch: PullBatch): Promise<void> {
    if (this.stopped) return;
    syncClock(batch.serverTime);
    this.set({ state: "syncing", catchingUp: !batch.complete });

    const { needBodies, reload, incoming, renamed } = await applyBatch(batch);

    for (const update of incoming) {
      if (!update.iv) {
        applyRemote(update.noteId, update.data);
        // This device's other windows with it open take it in too (see peers.ts).
        tellPeers({ kind: "update", noteId: update.noteId, update: update.data });
        continue;
      }
      // Locked: read again from storage there, with their own vault.
      tellPeers({ kind: "reload", noteId: update.noteId });
      const note = await db().notes.get(update.noteId);
      if (!note?.wrappedKey || !vault.isUnlocked) continue;
      try {
        const key = await vault.noteKey(update.noteId, update.keyEpoch, note.wrappedKey);
        applyRemote(
          update.noteId,
          await open(key, update.data, update.iv, ctx.yjsUpdate(update.noteId, update.keyEpoch)),
        );
      } catch {
        // Wrong epoch or locked vault: the body refetch will sort it out.
      }
    }
    // With every update above in, an open note they reached is as up to date
    // as it gets, and an old quick note among them is rewritten as opening it
    // would have been; not after each update, as a later one may be another
    // device's rewrite. One with a body still to fetch waits for that.
    const fetching = new Set(needBodies);
    for (const noteId of new Set(incoming.map((update) => update.noteId))) {
      if (!fetching.has(noteId)) await migrateOpenDoc(noteId);
    }

    for (const noteId of reload) await reloadDoc(noteId);
    // A note changed on another device, its whole body here: its text and
    // links taken from it again, for search and for the notes it links to.
    // Until now they stayed as they were until the note was edited here.
    for (const noteId of new Set(incoming.map((update) => update.noteId))) {
      if (fetching.has(noteId)) continue;
      const body = await db().bodies.get(noteId);
      if (body) await this.refreshText(noteId, body.throughSeq, body.keyEpoch).catch(() => {});
    }
    if (needBodies.length > 0) {
      // A failure here is recoverable: the notes stay marked as behind and the
      // next batch asks for them again.
      await this.fetchBodies(needBodies).catch(() => {});
    }

    await setMeta(META.lastSyncAt, Date.now());
    this.set({ state: "idle", lastSyncAt: Date.now(), catchingUp: !batch.complete });

    // From where it has got to: the subscription would otherwise send all
    // that came since it started again with every change, more and more
    // of it (up to a page) the longer another device is typed on, each time
    // read by the server and taken in again here.
    if (!batch.complete || batch.cursor > this.since) await this.resubscribe();
    if (batch.complete) {
      // Inbox may just have arrived, for a note made before it did.
      void import("./mutations")
        .then(({ fileAwaitingInbox }) => fileAwaitingInbox())
        .catch(() => 0);
      void this.dropGhosts();
      // Names two devices gave notes of one folder at once, and those from
      // before names were held to being a folder's own: numbered, the same
      // way on every device (lib/note-titles). Once everything is in, and
      // then only when a batch named or moved a note: every push of this
      // device's own edits comes back as a batch, and settling read every
      // note each time, about once a second while typing.
      if (renamed.length > 0 || !this.settledTitles) {
        this.settledTitles = true;
        void import("./mutations")
          .then(({ settleAllNoteTitles }) => settleAllNoteTitles())
          .catch(() => undefined);
      }
    }
  }

  /**
   * Lets go of the folders and notes kept here that the server no longer has.
   *
   * A purge reaches a device as a tombstone, and tombstones are kept only so
   * long: a device behind for longer, or one that missed a tombstone dropped
   * too soon, would keep the item for good, in its trash or its tree. Asked
   * once everything has been pulled, after a full resync and once on any
   * device that has not asked before. What this device has made or changed
   * and not yet sent is not asked about.
   */
  private async dropGhosts(): Promise<void> {
    if (this.checkingGhosts || (await getMeta<boolean>(META.ghostsChecked, false))) return;
    this.checkingGhosts = true;
    try {
      const database = db();
      const pending = new Set((await database.outbox.toArray()).map((entry) => entry.entityId));
      const known = <T extends { seq: number }>(rows: T[], id: (row: T) => string) =>
        rows.filter((row) => row.seq > 0 && !pending.has(id(row))).map(id);
      const folderIds = known(await database.folders.toArray(), (folder) => folder.folderId);
      const noteIds = known(await database.notes.toArray(), (note) => note.noteId);

      for (let at = 0; at < Math.max(folderIds.length, noteIds.length); at += GHOST_BATCH) {
        if (this.stopped) return;
        const gone = await this.client.query(api.sync.missing, {
          folderIds: folderIds.slice(at, at + GHOST_BATCH),
          noteIds: noteIds.slice(at, at + GHOST_BATCH),
        });
        if (!gone || this.stopped) return;
        await database.transaction(
          "rw",
          [database.folders, database.notes, database.updates, database.snapshots, database.bodies],
          async () => {
            for (const folderId of gone.folderIds) await database.folders.delete(folderId);
            for (const noteId of gone.noteIds) {
              await database.notes.delete(noteId);
              await database.updates.where("noteId").equals(noteId).delete();
              await database.snapshots.delete(noteId);
              await database.bodies.delete(noteId);
            }
          },
        );
      }
      await setMeta(META.ghostsChecked, true);
    } catch {
      // Asked again after the next pull that brings everything.
    } finally {
      this.checkingGhosts = false;
    }
  }

  /** Pulls snapshots and updates for notes this device is behind on. */
  async fetchBodies(noteIds: string[]): Promise<void> {
    await this.pullBodies(noteIds);
  }

  /** As fetchBodies, saying each note's key epoch as the server has it now. */
  private async pullBodies(noteIds: string[]): Promise<Map<string, number>> {
    const database = db();
    const epochs = new Map<string, number>();
    for (let at = 0; at < noteIds.length; at += BODY_BATCH) {
      if (this.stopped) return epochs;
      const slice = noteIds.slice(at, at + BODY_BATCH);
      const items = await Promise.all(
        slice.map(async (noteId) => {
          const note = await database.notes.get(noteId);
          const body = await database.bodies.get(noteId);
          const usable = body && note && body.keyEpoch === note.keyEpoch;
          return { noteId, haveThroughSeq: usable ? body.throughSeq : 0 };
        }),
      );

      const result = await this.client.query(api.notes.getBodies, { items });
      // Stopped while asking: the local data may be another account's by now.
      if (this.stopped) return epochs;
      for (const body of result.bodies) {
        epochs.set(body.noteId, body.keyEpoch);
        await this.ingestBody(body);
      }
      if (result.truncated) at -= BODY_BATCH / 2;
    }
    return epochs;
  }

  private async ingestBody(body: RemoteBody): Promise<void> {
    const database = db();
    const snapshot = body.snapshot;
    const bytes = !snapshot
      ? null
      : snapshot.payload
        ? new Uint8Array(snapshot.payload)
        : snapshot.url
          ? // Not kept by the service worker or the browser: a note locked
            // later would leave this copy of its text behind.
            new Uint8Array(await (await fetch(snapshot.url, { cache: "no-store" })).arrayBuffer())
          : null;

    // Written all at once, and not at all once the engine has stopped: by
    // then the local data may have been wiped for another account.
    const through = await database.transaction(
      "rw",
      [database.snapshots, database.updates],
      async () => {
        if (this.stopped) return null;
        let through = 0;
        if (snapshot && bytes) {
          await database.snapshots.put({
            noteId: body.noteId,
            data: bytes,
            iv: snapshot.iv ? new Uint8Array(snapshot.iv) : undefined,
            keyEpoch: body.keyEpoch,
            throughSeq: snapshot.coversThroughSeq,
          });
          // Everything the snapshot already contains can go.
          await database.updates
            .where("noteId")
            .equals(body.noteId)
            .filter((u) => u.seq !== null && u.seq <= snapshot.coversThroughSeq)
            .delete();
          through = snapshot.coversThroughSeq;
        }
        // What was kept here under another key (from before a lock or unlock)
        // is in what just came, and that key cannot open it any more.
        await database.updates
          .where("noteId")
          .equals(body.noteId)
          .filter((u) => u.keyEpoch !== body.keyEpoch && u.pushed === 1)
          .delete();

        for (const update of body.updates) {
          const existing = await database.updates.where("opId").equals(update.opId).first();
          if (existing) {
            if (existing.seq !== update.seq) {
              await database.updates.update(existing.localId!, { seq: update.seq, pushed: 1 });
            }
          } else {
            await database.updates.add({
              noteId: body.noteId,
              seq: update.seq,
              opId: update.opId,
              keyEpoch: update.keyEpoch,
              data: new Uint8Array(update.payload),
              iv: update.iv ? new Uint8Array(update.iv) : undefined,
              pushed: 1,
              createdAt: Date.now(),
            });
          }
          through = Math.max(through, update.seq);
        }
        return through;
      },
    );
    if (through === null || this.stopped) return;

    await reloadDoc(body.noteId);
    await this.refreshText(body.noteId, through, body.keyEpoch);
    // An old quick note open meanwhile is rewritten as opening it would have
    // been: only now, with how far the local copy reaches recorded, as until
    // then it counts as behind.
    await migrateOpenDoc(body.noteId);
  }

  /** Recomputes the searchable text and preview after the body changed. */
  async refreshText(noteId: string, throughSeq: number, keyEpoch: number): Promise<void> {
    const database = db();
    const note = await database.notes.get(noteId);
    const locked = note?.locked === true;
    const readable = !locked || vault.isUnlocked;

    let text: string | null = null;
    let links: string[] = [];
    if (readable) {
      [text, links] = await withDetachedDoc(
        noteId,
        (doc) => [extractText(doc), linkTargets(doc)] as const,
      );
    }

    if (this.stopped) return;
    await database.bodies.put({
      noteId,
      throughSeq,
      keyEpoch,
      text: locked ? null : text,
      links: locked ? [] : links,
      updatedAt: Date.now(),
    });

    // Keep the list row in step with the body this device just caught up on,
    // without sending anything: the peer that made the edit already published
    // its own preview.
    if (note && !locked && text !== null) {
      const preview = firstLine(text, 160);
      if (preview !== note.preview) await database.notes.update(noteId, { preview });
    }
  }

  /* --------------------------------------------------------------- pushing */

  /** `final`: the last push of a page going away, sent though the lock has been let go (see letGo). */
  private async drain(final = false): Promise<void> {
    if ((!this.leader && !final) || this.stopped || this.draining) return;
    this.draining = true;
    try {
      const database = db();
      // Files first: an image the editor already shows should reach the server
      // before the block that references it is compacted.
      let uploadRefused = await this.sendFiles();
      const heldForVault = await this.rebaseRefused();
      // Ops the server threw on this round: left for the next round, so the
      // ones after them go now rather than wait on them.
      const failedNow = new Set<string>();
      for (;;) {
        const now = Date.now();
        const entries = await database.outbox
          .orderBy("createdAt")
          .filter(
            (entry) =>
              entry.stuck === undefined &&
              !(entry.retryAt && entry.retryAt > now) &&
              !failedNow.has(entry.opId),
          )
          .limit(PUSH_OP_LIMIT)
          .toArray();
        this.set({ pending: await this.pendingCount() });
        if (entries.length === 0) break;

        const ops: Record<string, unknown>[] = [];
        let bytes = 0;
        for (const entry of entries) {
          const payload = entry.payload as Record<string, unknown>;
          const size = estimateSize(payload);
          if (ops.length > 0 && bytes + size > PUSH_BYTE_BUDGET) break;
          ops.push(payload);
          bytes += size;
        }

        // The notes these edits change, as they were before them, where a
        // version of one is due (lib/sync/versions): read now, kept once sent.
        const { stateBeforeEdits, keepVersion } = await import("./versions");
        const before = new Map<string, Uint8Array>();
        for (const entry of entries.slice(0, ops.length)) {
          if (entry.kind !== "update" || before.has(entry.entityId)) continue;
          const state = await stateBeforeEdits(entry.entityId);
          if (state) before.set(entry.entityId, state);
        }

        this.sentAt = Date.now();
        const pushed = await this.push(entries.slice(0, ops.length), ops, failedNow);
        if (!pushed) continue;
        const { response, sent } = pushed;
        for (const [noteId, state] of before) {
          if (sent.some((entry) => entry.entityId === noteId)) {
            void keepVersion(this.client, noteId, state);
          }
        }
        syncClock(response.serverTime);

        const byId = new Map(response.results.map((r) => [r.opId, r]));
        for (const entry of sent) {
          const result = byId.get(entry.opId);
          if (!result) continue;
          if (result.status === "ok") {
            await database.outbox.delete(entry.opId);
            // The file is the server's now: the row that waited with it goes.
            if (entry.kind === "attachment.commit") {
              const { commitAccepted } = await import("@/lib/media/attachments");
              await commitAccepted(entry.entityId);
            }
          } else {
            await this.handleRejection(entry.opId, entry.kind, result.reason, entry.entityId);
          }
        }

        this.interval = response.activePeers > 0 ? FAST_INTERVAL_MS : IDLE_INTERVAL_MS;
        for (const noteId of response.shouldCompact) void this.compact(noteId);
        if (sent.length === entries.length && entries.length < PUSH_OP_LIMIT) break;
      }
      // A file for a note that has only now reached the server waited above.
      if ((await database.pendingUploads.count()) > 0) {
        uploadRefused = (await this.sendFiles()) || uploadRefused;
      }
      this.set({
        state: "idle",
        pending: await this.pendingCount(),
        // Held for want of room, not for a note still to reach the server.
        quotaFull:
          (await database.outbox
            .filter(
              (entry) =>
                entry.retryAt !== undefined &&
                entry.stuck === undefined &&
                entry.lastError !== "unknownNote",
            )
            .count()) > 0,
        heldForVault,
        stuck: await this.stuckCount(),
        uploadRefused,
      });
      // Everything of ours is sent: a good moment, and this loop keeps
      // running while nothing else happens, which a quiet note needs.
      void this.reportRefs();
    } catch {
      this.set({ state: navigator.onLine === false ? "offline" : "error" });
    } finally {
      this.draining = false;
      const again = this.again;
      const againPaced = this.againPaced;
      this.again = false;
      this.againPaced = false;
      // The next round, while this window is the one that syncs: straight
      // away for what was asked for during this one, edits queued meanwhile
      // as paced (kickPaced).
      if (!this.stopped && this.leader) {
        if (this.timer) clearTimeout(this.timer);
        const next = again
          ? 0
          : againPaced
            ? Math.max(0, this.sentAt + PUSH_EVERY_MS - Date.now())
            : this.interval;
        this.timer = setTimeout(() => void this.drain(), next);
      }
    }
  }

  /**
   * Sends the files waiting to go up. Whether the server refused one (too
   * large, or no room): that file is dropped, and the note shows nothing
   * for it, which is to be said. Anything else (no network, say) is tried
   * again with the next round.
   */
  private async sendFiles(): Promise<boolean> {
    const { flushUploads, QuotaError } = await import("@/lib/media/attachments");
    try {
      await flushUploads(this.client);
      return false;
    } catch (error) {
      return error instanceof QuotaError;
    }
  }

  /**
   * Sends ops in one push. One the server throws on, as a whole (an
   * argument it does not take, a row too large to store), would otherwise
   * be sent again with every round, and every edit after it wait behind it
   * for good. Thrown on, the first is sent alone: gone through, the one
   * refused is among the rest, found the same way next time round; thrown
   * on by itself, it is counted against, set aside after STUCK_AFTER tries
   * (to be sent again on request), and left out of this round. What was
   * sent, with the server's answer; null when the first could not be.
   */
  private async push(
    entries: OutboxEntry[],
    ops: Record<string, unknown>[],
    failedNow: Set<string>,
  ): Promise<{ response: PushResponse; sent: OutboxEntry[] } | null> {
    const send = (batch: Record<string, unknown>[]) =>
      this.client.mutation(api.sync.push, { deviceId: this.device, ops: batch as never });
    try {
      return { response: await send(ops), sent: entries };
    } catch (error) {
      // Not reached: left as they are, for when the network is back.
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw error;
      const first = entries[0]!;
      if (ops.length > 1) {
        try {
          return { response: await send([ops[0]!]), sent: [first] };
        } catch (alone) {
          await this.failedToSend(first, alone);
        }
      } else {
        await this.failedToSend(first, error);
      }
      failedNow.add(first.opId);
      return null;
    }
  }

  /**
   * Stamps an op anew (see lib/sync/restamp), and the local row it is for
   * along with it, where the row still carries the stamp the op did: kept
   * ahead there, an edit from elsewhere would lose here while winning on
   * the server. Stored together, so a read in between sees neither or both.
   */
  private async restamp(entry: OutboxEntry): Promise<void> {
    const database = db();
    const { payload, changed } = restampOp(entry.payload as Record<string, unknown>, this.device);
    const table =
      entry.kind === "note" ? database.notes : entry.kind === "folder" ? database.folders : null;
    await database.transaction("rw", [database.outbox, database.notes, database.folders], async () => {
      await database.outbox.update(entry.opId, { payload, attempts: entry.attempts + 1 });
      if (!table) return;
      const row = await table.get(entry.entityId);
      if (!row) return;
      const stamps = row.ts as Record<string, Stamp | undefined>;
      const patch: Record<string, Stamp> = {};
      for (const { group, was, now } of changed) {
        const current = stamps[group];
        if (current && current.t === was.t && current.d === was.d) patch[`ts.${group}`] = now;
      }
      if (Object.keys(patch).length > 0) await table.update(entry.entityId, patch as never);
    });
  }

  /** Counts a push the server threw on against its op; set aside after STUCK_AFTER. */
  private async failedToSend(entry: OutboxEntry, error: unknown): Promise<void> {
    const attempts = entry.attempts + 1;
    await db().outbox.update(entry.opId, {
      attempts,
      lastError: error instanceof Error ? error.message : String(error),
      ...(attempts >= STUCK_AFTER ? { stuck: Date.now() } : {}),
    });
  }

  /** Sends the ops set aside again, from the start. */
  async retryStuck(): Promise<void> {
    await db()
      .outbox.filter((entry) => entry.stuck !== undefined)
      .modify((entry) => {
        delete entry.stuck;
        entry.attempts = 0;
      });
    this.set({ stuck: 0 });
    this.kick(0);
  }

  /** The ops waiting to be sent, those set aside not among them. */
  private pendingCount(): Promise<number> {
    return db()
      .outbox.filter((entry) => entry.stuck === undefined)
      .count();
  }

  private stuckCount(): Promise<number> {
    return db()
      .outbox.filter((entry) => entry.stuck !== undefined)
      .count();
  }

  /**
   * A rejected operation is dropped rather than retried forever. The two that
   * matter are a stale clock, which the client has already corrected, and a
   * stale key epoch, which means the note was locked or unlocked elsewhere and
   * the local edit has to be re-derived against the new epoch (rebaseNote).
   *
   * An edit to a note's text refused because the account is full is the
   * exception: it is kept, and sent again from time to time until there is
   * room. Dropped, it would be gone from this device too once the note was
   * closed, and what came after it would wait on other devices for it. One
   * too large for the server to store in one row is kept the same way, set
   * aside: dropped, the text it holds would be gone from here too.
   */
  private async handleRejection(
    opId: string,
    kind: string,
    reason?: string,
    entityId?: string,
  ): Promise<void> {
    const database = db();
    if (kind === "attachment.commit") {
      // The file's row waited with the file (lib/media/attachments): sent up
      // again when the server let the upload go, given up when it does not
      // know the file at all (its note purged).
      await database.outbox.delete(opId);
      if (!entityId) return;
      const { uploadAgain, discardUploaded } = await import("@/lib/media/attachments");
      if (reason && UPLOAD_AGAIN.has(reason)) {
        await uploadAgain(entityId);
        this.again = true;
      } else {
        await discardUploaded(entityId);
      }
      return;
    }
    if (reason === "quotaExceeded" && kind === "update") {
      await database.outbox.update(opId, { retryAt: Date.now() + QUOTA_RETRY_MS });
      this.set({ quotaFull: true });
      return;
    }
    if (reason === "tooLarge" && kind === "update") {
      await database.outbox.update(opId, { stuck: Date.now(), lastError: reason });
      return;
    }
    if (reason === "clockSkew") {
      // Stamped while this device's clock ran ahead: stamped again, by the
      // clock as the server's answer has just corrected it, and sent again
      // at once. Never dropped: a note's making would go with it, and then
      // its text (every edit to a note the server does not have is refused).
      const entry = await database.outbox.get(opId);
      if (entry && entry.attempts < 5) {
        await this.restamp(entry);
        this.again = true;
        return;
      }
      if (entry) {
        await database.outbox.update(opId, { stuck: Date.now(), lastError: reason });
        return;
      }
    }
    if (reason === "unknownNote" && kind === "update") {
      // The note is not on the server yet: its making is still to go (sent
      // again after a refusal, say), or was set aside. Held while the note
      // is here, for the round after the next.
      const entry = await database.outbox.get(opId);
      const note = entry ? await database.notes.get(entry.entityId) : undefined;
      if (entry && note && !note.purged && entry.attempts < UNKNOWN_NOTE_TRIES) {
        await database.outbox.update(opId, {
          retryAt: Date.now() + UNKNOWN_NOTE_RETRY_MS,
          attempts: entry.attempts + 1,
          lastError: reason,
        });
        return;
      }
    }
    await database.outbox.delete(opId);
    if (kind !== "update") return;
    if (reason === "epochMismatch") {
      // The stored edit is kept: in a note not open here it is the only copy
      // of what was typed. The push that follows at once sends it again
      // under the note's new epoch (rebaseRefused).
      this.again = true;
      return;
    }
    await database.updates.where("opId").equals(opId).delete();
  }

  /**
   * The edits refused for their key epoch, sent again: at once after the
   * refusal, or, when that could not be done then, with a later push. Until
   * the pull brings the note's new epoch this device does not know what to
   * send them under, and a locked note's are sealed only with the vault open,
   * as files are (flushUploads). Whether any wait for the vault.
   */
  private async rebaseRefused(): Promise<boolean> {
    const byNote = new Map<string, LocalUpdate[]>();
    for (const update of await editsOutOfOutbox()) {
      byNote.set(update.noteId, [...(byNote.get(update.noteId) ?? []), update]);
    }
    let held = false;
    for (const [noteId, kept] of byNote) {
      // One that cannot be done now is tried again by a later push.
      if (await this.rebaseNote(noteId, kept).catch(() => false)) held = true;
    }
    return held;
  }

  /**
   * Re-sends a note's refused edits under the epoch the server now expects.
   *
   * What changed is how they must be encrypted, so they are re-derived as a
   * Yjs diff: the note as stored here with them, against the note as the
   * server has it once its new body is in. Both are read from storage, never
   * from the document open here: the editor's document takes in that body
   * too, and so already holds everything, which left nothing to send; and
   * what it has not stored yet is stored and sent on its own. Other edits
   * waiting to be sent are left out of both, so what is queued already does
   * not go twice.
   *
   * `kept` are the note's edits not sent and not queued. Whether its refused
   * ones wait for the vault to be opened.
   */
  private async rebaseNote(noteId: string, kept: LocalUpdate[]): Promise<boolean> {
    const database = db();
    const note = await database.notes.get(noteId);
    if (!note) return false;
    // Refused: under an epoch the note has since left. One under the epoch
    // this device still has waits for the pull to bring the new one (or was
    // taken in by the server a moment ago, and is on its way back).
    const refused = kept.filter((update) => update.keyEpoch !== note.keyEpoch);
    // One sealed under the key the note has left cannot be read with the one
    // it has now (hydrate fails on it), and goes.
    const sealed = refused.filter((update) => update.iv).map((update) => update.localId!);
    if (sealed.length > 0) await database.updates.bulkDelete(sealed);
    const plain = new Set(refused.filter((update) => !update.iv).map((update) => update.localId!));
    if (plain.size === 0) return false;
    if (note.locked && (!note.wrappedKey || !vault.isUnlocked)) return true; // Retried after unlock.

    // The server asked again only after a while, longer each time, while it
    // does not work out; at once when the note's epoch has moved since.
    const wait = this.rebaseWaits.get(noteId);
    const previous = wait?.epoch === note.keyEpoch ? wait : undefined;
    if (previous && previous.at > Date.now()) return false;
    const tries = (previous?.tries ?? 0) + 1;
    const delay = Math.min(REBASE_RETRY_MS * 2 ** (tries - 1), REBASE_RETRY_MAX_MS);
    this.rebaseWaits.set(noteId, { epoch: note.keyEpoch, tries, at: Date.now() + delay });

    // Sealed under an epoch the server has already left (locked, then
    // unlocked again elsewhere), they would be refused again, and then
    // dropped as unreadable once the pull brings that epoch: they wait for it.
    const epochs = await this.pullBodies([noteId]);
    if (epochs.get(noteId) !== note.keyEpoch) return false;
    const local = await withDocFromStorage(
      noteId,
      (doc) => Y.encodeStateAsUpdate(doc),
      (update) => update.pushed === 0 && !plain.has(update.localId!),
    );
    const [server, has] = await withDocFromStorage(
      noteId,
      (doc) => [Y.encodeStateVector(doc), Y.snapshot(doc)] as const,
      (update) => update.pushed === 0,
    );

    const fresh = await database.notes.get(noteId);
    // Locked or unlocked again meanwhile: done again under that epoch. Nothing
    // written once the engine has stopped: by then the local data may be
    // another account's.
    if (this.stopped || !fresh || fresh.keyEpoch !== note.keyEpoch) return false;
    // Nothing the server lacks (taken in before the epoch moved on, or sent
    // again with others already): they go. Asked of what the server has, not
    // of the diff's length: a diff with nothing in it still has bytes.
    if (Y.snapshotContainsUpdate(has, local)) {
      await database.updates.bulkDelete([...plain]);
      this.rebaseWaits.delete(noteId);
      return false;
    }
    const diff = Y.diffUpdate(local, server);

    let data = diff;
    let iv: Uint8Array | undefined;
    if (fresh.locked) {
      if (!fresh.wrappedKey || !vault.isUnlocked) return true; // Retried after unlock.
      const key = await vault.noteKey(noteId, fresh.keyEpoch, fresh.wrappedKey);
      const sealed = await seal(key, diff, ctx.yjsUpdate(noteId, fresh.keyEpoch));
      data = sealed.ct;
      iv = sealed.iv;
    }

    const { uuidv7 } = await import("uuidv7");
    const opId = uuidv7();
    // In their place in one go, as write() stores and queues: a note read
    // in between would lack what was typed. Not at all if the engine has
    // stopped meanwhile.
    await database.transaction("rw", [database.updates, database.outbox], async () => {
      if (this.stopped) return;
      await database.updates.bulkDelete([...plain]);
      await database.updates.add({
        noteId,
        seq: null,
        opId,
        keyEpoch: fresh.keyEpoch,
        data,
        iv,
        pushed: 0,
        createdAt: Date.now(),
      });
      await enqueue({
        opId,
        kind: "update",
        entityId: noteId,
        payload: {
          kind: "update",
          noteId,
          keyEpoch: fresh.keyEpoch,
          payload: toArrayBuffer(data),
          ...(iv ? { iv: toArrayBuffer(iv) } : {}),
        },
      });
    });
    this.rebaseWaits.delete(noteId);
    return false;
  }

  /**
   * Folds a note's updates into one snapshot.
   *
   * Only a device that holds every update may do this, because the server
   * cannot merge ciphertext. Refusing when anything is unpushed or unreadable
   * is what keeps the deletion of those updates safe.
   */
  async compact(noteId: string): Promise<boolean> {
    // One at a time for a note: every push's answer asks for it again until
    // it is done, and each would have sent the whole note. One refused a
    // moment ago is not tried again for a while.
    const running = this.compacting.get(noteId);
    if (running) return running;
    if (Date.now() - (this.compactFailedAt.get(noteId) ?? 0) < COMPACT_RETRY_MS) return false;
    const attempt = this.compactNow(noteId)
      .then((done) => {
        if (!done) this.compactFailedAt.set(noteId, Date.now());
        return done;
      })
      .finally(() => this.compacting.delete(noteId));
    this.compacting.set(noteId, attempt);
    return attempt;
  }

  private async compactNow(noteId: string): Promise<boolean> {
    const database = db();
    const note = await database.notes.get(noteId);
    const body = await database.bodies.get(noteId);
    if (!note || !body) return false;
    if (body.throughSeq !== note.lastUpdateSeq) return false;
    if (body.keyEpoch !== note.keyEpoch) return false;
    const unpushed = await database.updates
      .where("noteId")
      .equals(noteId)
      .filter((u) => u.pushed === 0)
      .count();
    if (unpushed > 0) return false;
    if (note.locked && (!note.wrappedKey || !vault.isUnlocked)) return false;

    const merged = await withDetachedDoc(noteId, (doc) => Y.encodeStateAsUpdate(doc));
    let payload = merged;
    let iv: Uint8Array | undefined;
    if (note.locked && note.wrappedKey) {
      const key = await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey);
      const sealed = await seal(key, merged, ctx.yjsSnapshot(noteId, note.keyEpoch));
      payload = sealed.ct;
      iv = sealed.iv;
    }

    // Inline, or (a long note, past what one row holds) by the file it is
    // uploaded as: sent inline whatever its size, the server refused every
    // snapshot of a long note, which was never compacted then.
    const { snapshotArg } = await import("./snapshot-upload");
    const result = await this.client.mutation(api.notes.compact, {
      noteId,
      keyEpoch: note.keyEpoch,
      coversThroughSeq: note.lastUpdateSeq,
      ...(await snapshotArg(this.client, payload, iv)),
    });
    if (result.status !== "ok") return false;

    // Mirror the server locally so the snapshot header that arrives next does
    // not look like something this device still needs to download.
    await database.snapshots.put({
      noteId,
      data: payload,
      iv,
      keyEpoch: note.keyEpoch,
      throughSeq: note.lastUpdateSeq,
    });
    await database.updates
      .where("noteId")
      .equals(noteId)
      .filter((u) => u.seq !== null && u.seq <= note.lastUpdateSeq)
      .delete();
    return true;
  }

  /**
   * Tells the server which files recently changed notes use, so files no
   * note uses any more can be deleted. Throttled: a few notes at a time is
   * plenty, and nothing about it is urgent.
   */
  private async reportRefs(): Promise<void> {
    if (Date.now() - this.lastRefsPass < 20_000) return;
    this.lastRefsPass = Date.now();
    const { reportAttachmentRefs } = await import("@/lib/media/report-refs");
    await reportAttachmentRefs(this.client, (noteIds) => this.fetchBodies(noteIds)).catch(() => 0);
  }

  /** Warms the cache with the notes the person is most likely to open. */
  async prefetchBodies(): Promise<void> {
    const database = db();
    const notes = await database.notes
      .orderBy("updatedAt")
      .reverse()
      .limit(PREFETCH_LIMIT)
      .toArray();
    const missing: string[] = [];
    for (const note of notes) {
      if (note.deletedAt !== null || note.purged) continue;
      const body = await database.bodies.get(note.noteId);
      if (!body || body.keyEpoch !== note.keyEpoch || body.throughSeq < note.snapshotSeq) {
        missing.push(note.noteId);
      } else if (await hasStaleParts(note.noteId, note.keyEpoch)) {
        // Counted as whole by an earlier version, with parts of another key
        // left over: fetched again, all of it.
        await database.bodies.update(note.noteId, { throughSeq: 0 });
        missing.push(note.noteId);
      }
    }
    if (missing.length > 0) await this.fetchBodies(missing);
  }
}

/** Whether this device keeps parts of a note under a key other than the note's own. */
async function hasStaleParts(noteId: string, keyEpoch: number): Promise<boolean> {
  const database = db();
  const snapshot = await database.snapshots.get(noteId);
  if (snapshot && snapshot.keyEpoch !== keyEpoch) return true;
  const stale = await database.updates
    .where("noteId")
    .equals(noteId)
    .filter((u) => u.keyEpoch !== keyEpoch && u.pushed === 1)
    .count();
  return stale > 0;
}

function estimateSize(payload: Record<string, unknown>): number {
  const buffer = payload.payload;
  if (buffer instanceof ArrayBuffer) return buffer.byteLength + 256;
  return 512;
}
