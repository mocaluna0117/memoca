"use client";

import type { ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import * as Y from "yjs";
import { api } from "@convex/_generated/api";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { open, seal } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, resetLocalData, setMeta } from "@/lib/db";
import { META, deviceId as ensureDeviceId } from "@/lib/db/meta";
import { type PullBatch, applyBatch } from "./apply";
import { loadClock, syncClock } from "./clock";
import { onOutboxChanged } from "./signal";
import { tellPeers } from "./peers";
import { applyRemote, migrateOpenDoc, reloadDoc, withDetachedDoc } from "./docs";
import { extractText, firstLine } from "./ydoc";
import { linkTargets } from "@/lib/note-links";

/** Bytes of operations to send in one push. The server accepts up to 4 MiB. */
const PUSH_BYTE_BUDGET = 1_000_000;
const PUSH_OP_LIMIT = 50;
/** Poll cadence while another device is actively editing. */
const FAST_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
/** How long an edit refused for want of room waits before it is sent again. */
const QUOTA_RETRY_MS = 60_000;
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

type RemoteBody = FunctionReturnType<typeof api.notes.getBodies>["bodies"][number];

export type SyncStatus = {
  state: "idle" | "syncing" | "offline" | "error";
  pending: number;
  lastSyncAt: number | null;
  catchingUp: boolean;
  /** Edits are waiting for room: the account is full, and they are not saved on the server. */
  quotaFull: boolean;
};

type Listener = (status: SyncStatus) => void;

export class SyncEngine {
  private device = "";
  private stopped = true;
  private leader = false;
  private releaseLock: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private unwatchOutbox: (() => void) | null = null;
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
  private checkingGhosts = false;
  private listeners = new Set<Listener>();
  private status: SyncStatus = {
    state: "idle",
    pending: 0,
    lastSyncAt: null,
    catchingUp: false,
    quotaFull: false,
  };

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
    this.status = { ...this.status, ...patch };
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

    this.claimLeadership();
    this.attachWindowHooks();
    this.unwatchOutbox = onOutboxChanged(() => this.kick(250));
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unwatchOutbox?.();
    this.unwatchOutbox = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.leader = false;
    this.detachWindowHooks();
  }

  /**
   * Only one tab syncs. The others still read and write the same local
   * database, so their UI stays live; they just do not open a second
   * subscription or race on the outbox.
   */
  private claimLeadership(): void {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) {
      this.leader = true;
      void this.run();
      return;
    }
    void locks.request("memoca-sync", { mode: "exclusive" }, () => {
      if (this.stopped) return Promise.resolve();
      this.leader = true;
      void this.run();
      return new Promise<void>((resolve) => {
        this.releaseLock = resolve;
      });
    });
  }

  private onOnline = () => this.kick(0);
  private onVisibility = () => {
    if (document.visibilityState === "hidden") void this.drain();
    else this.kick(0);
  };
  private onPageHide = () => void this.drain();

  private attachWindowHooks() {
    if (typeof window === "undefined") return;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private detachWindowHooks() {
    if (typeof window === "undefined") return;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibility);
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
    if (this.stopped) return;
    this.unwatch?.();
    const since = await getMeta<number>(META.cursor, 0);
    this.since = since;
    const watching = ++this.watching;
    const watch = this.client.watchQuery(api.sync.pull, { since });

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

    const { needBodies, reload, incoming } = await applyBatch(batch);

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
      // way on every device (lib/note-titles).
      void import("./mutations")
        .then(({ settleAllNoteTitles }) => settleAllNoteTitles())
        .catch(() => undefined);
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
    const database = db();
    for (let at = 0; at < noteIds.length; at += BODY_BATCH) {
      if (this.stopped) return;
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
      if (this.stopped) return;
      for (const body of result.bodies) {
        await this.ingestBody(body);
      }
      if (result.truncated) at -= BODY_BATCH / 2;
    }
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
      [text, links] = await withDetachedDoc(noteId, (doc) => [extractText(doc), linkTargets(doc)] as const);
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

  private async drain(): Promise<void> {
    if (!this.leader || this.stopped || this.draining) return;
    this.draining = true;
    try {
      const database = db();
      // Files first: an image the editor already shows should reach the server
      // before the block that references it is compacted.
      const { flushUploads } = await import("@/lib/media/attachments");
      await flushUploads(this.client).catch(() => {});
      for (;;) {
        const now = Date.now();
        const entries = await database.outbox
          .orderBy("createdAt")
          .filter((entry) => !(entry.retryAt && entry.retryAt > now))
          .limit(PUSH_OP_LIMIT)
          .toArray();
        this.set({ pending: await database.outbox.count() });
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

        const response = await this.client.mutation(api.sync.push, {
          deviceId: this.device,
          ops: ops as never,
        });
        for (const [noteId, state] of before) void keepVersion(this.client, noteId, state);
        syncClock(response.serverTime);

        const byId = new Map(response.results.map((r) => [r.opId, r]));
        for (const entry of entries.slice(0, ops.length)) {
          const result = byId.get(entry.opId);
          if (!result) continue;
          if (result.status === "ok") {
            await database.outbox.delete(entry.opId);
          } else {
            await this.handleRejection(entry.opId, entry.kind, entry.entityId, result.reason);
          }
        }

        this.interval = response.activePeers > 0 ? FAST_INTERVAL_MS : IDLE_INTERVAL_MS;
        for (const noteId of response.shouldCompact) void this.compact(noteId);
        if (ops.length === entries.length && entries.length < PUSH_OP_LIMIT) break;
      }
      // A file for a note that has only now reached the server waited above.
      if ((await database.pendingUploads.count()) > 0)
        await flushUploads(this.client).catch(() => {});
      this.set({
        state: "idle",
        pending: await database.outbox.count(),
        quotaFull: (await database.outbox.filter((entry) => entry.retryAt !== undefined).count()) > 0,
      });
      // Everything of ours is sent: a good moment, and this loop keeps
      // running while nothing else happens, which a quiet note needs.
      void this.reportRefs();
    } catch {
      this.set({ state: navigator.onLine === false ? "offline" : "error" });
    } finally {
      this.draining = false;
      const again = this.again;
      this.again = false;
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.drain(), again ? 0 : this.interval);
      }
    }
  }

  /**
   * A rejected operation is dropped rather than retried forever. The two that
   * matter are a stale clock, which the client has already corrected, and a
   * stale key epoch, which means the note was locked or unlocked elsewhere and
   * the local edit has to be re-derived against the new epoch.
   *
   * An edit to a note's text refused because the account is full is the
   * exception: it is kept, and sent again from time to time until there is
   * room. Dropped, it would be gone from this device too once the note was
   * closed, and what came after it would wait on other devices for it.
   */
  private async handleRejection(
    opId: string,
    kind: string,
    entityId: string,
    reason?: string,
  ): Promise<void> {
    const database = db();
    if (reason === "quotaExceeded" && kind === "update") {
      await database.outbox.update(opId, { retryAt: Date.now() + QUOTA_RETRY_MS });
      this.set({ quotaFull: true });
      return;
    }
    if (reason === "clockSkew") {
      const entry = await database.outbox.get(opId);
      if (entry && entry.attempts < 3) {
        await database.outbox.update(opId, { attempts: entry.attempts + 1 });
        return;
      }
    }
    await database.outbox.delete(opId);
    if (kind === "update") {
      await database.updates.where("opId").equals(opId).delete();
      if (reason === "epochMismatch") await this.rebaseNote(entityId);
    }
  }

  /**
   * Re-sends a note's local edits under the epoch the server now expects.
   *
   * The device's document still holds the work; what changed is how it must be
   * encrypted. Taking a Yjs diff against the server's state vector keeps the
   * edit and drops nothing.
   */
  private async rebaseNote(noteId: string): Promise<void> {
    const database = db();
    const note = await database.notes.get(noteId);
    if (!note) return;

    const local = await withDetachedDoc(noteId, (doc) => Y.encodeStateAsUpdate(doc));
    await this.fetchBodies([noteId]);
    const server = await withDetachedDoc(noteId, (doc) => Y.encodeStateVector(doc));

    const merged = new Y.Doc();
    Y.applyUpdate(merged, local);
    const diff = Y.encodeStateAsUpdate(merged, server);
    merged.destroy();
    if (diff.byteLength === 0) return;

    const fresh = await database.notes.get(noteId);
    if (!fresh) return;

    let data = diff;
    let iv: Uint8Array | undefined;
    if (fresh.locked) {
      if (!fresh.wrappedKey || !vault.isUnlocked) return; // Retried after unlock.
      const key = await vault.noteKey(noteId, fresh.keyEpoch, fresh.wrappedKey);
      const sealed = await seal(key, diff, ctx.yjsUpdate(noteId, fresh.keyEpoch));
      data = sealed.ct;
      iv = sealed.iv;
    }

    const { uuidv7 } = await import("uuidv7");
    const opId = uuidv7();
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
    const { enqueue } = await import("./outbox");
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
  }

  /**
   * Folds a note's updates into one snapshot.
   *
   * Only a device that holds every update may do this, because the server
   * cannot merge ciphertext. Refusing when anything is unpushed or unreadable
   * is what keeps the deletion of those updates safe.
   */
  async compact(noteId: string): Promise<boolean> {
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

    const result = await this.client.mutation(api.notes.compact, {
      noteId,
      keyEpoch: note.keyEpoch,
      coversThroughSeq: note.lastUpdateSeq,
      payload: toArrayBuffer(payload),
      size: payload.byteLength,
      ...(iv ? { iv: toArrayBuffer(iv) } : {}),
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
