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
import { applyRemote, reloadDoc, withDetachedDoc } from "./docs";
import { extractText, firstLine } from "./ydoc";

/** Bytes of operations to send in one push. The server accepts up to 4 MiB. */
const PUSH_BYTE_BUDGET = 1_000_000;
const PUSH_OP_LIMIT = 50;
/** Poll cadence while another device is actively editing. */
const FAST_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
/** Bodies fetched per round when catching up. */
const BODY_BATCH = 30;
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
};

type Listener = (status: SyncStatus) => void;

export class SyncEngine {
  private device = "";
  private stopped = true;
  private leader = false;
  private releaseLock: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private unwatchOutbox: (() => void) | null = null;
  private lastReadingPass = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval = IDLE_INTERVAL_MS;
  private draining = false;
  private listeners = new Set<Listener>();
  private status: SyncStatus = {
    state: "idle",
    pending: 0,
    lastSyncAt: null,
    catchingUp: false,
  };

  constructor(private client: ConvexReactClient) {}

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
    const watch = this.client.watchQuery(api.sync.pull, { since });

    const consume = () => {
      try {
        const result = watch.localQueryResult();
        // `null` means the server does not recognise this client yet, which is
        // normal for the moment between page load and the token attaching.
        if (result) void this.receive(result);
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
        continue;
      }
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

    for (const noteId of reload) await reloadDoc(noteId);
    if (needBodies.length > 0) {
      // A failure here is recoverable: the notes stay marked as behind and the
      // next batch asks for them again.
      await this.fetchBodies(needBodies).catch(() => {});
    }

    await setMeta(META.lastSyncAt, Date.now());
    this.set({ state: "idle", lastSyncAt: Date.now(), catchingUp: !batch.complete });
    void this.refreshReadings();

    if (!batch.complete) await this.resubscribe();
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
      for (const body of result.bodies) {
        await this.ingestBody(body);
      }
      if (result.truncated) at -= BODY_BATCH / 2;
    }
  }

  private async ingestBody(body: RemoteBody): Promise<void> {
    const database = db();
    let through = 0;

    if (body.snapshot) {
      const bytes = body.snapshot.payload
        ? new Uint8Array(body.snapshot.payload)
        : body.snapshot.url
          ? new Uint8Array(await (await fetch(body.snapshot.url)).arrayBuffer())
          : null;
      if (bytes) {
        await database.snapshots.put({
          noteId: body.noteId,
          data: bytes,
          iv: body.snapshot.iv ? new Uint8Array(body.snapshot.iv) : undefined,
          keyEpoch: body.keyEpoch,
          throughSeq: body.snapshot.coversThroughSeq,
        });
        // Everything the snapshot already contains can go.
        await database.updates
          .where("noteId")
          .equals(body.noteId)
          .filter((u) => u.seq !== null && u.seq <= body.snapshot!.coversThroughSeq)
          .delete();
        through = body.snapshot.coversThroughSeq;
      }
    }

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

    await reloadDoc(body.noteId);
    await this.refreshText(body.noteId, through, body.keyEpoch);
  }

  /** Recomputes the searchable text and preview after the body changed. */
  async refreshText(noteId: string, throughSeq: number, keyEpoch: number): Promise<void> {
    const database = db();
    const note = await database.notes.get(noteId);
    const locked = note?.locked === true;
    const readable = !locked || vault.isUnlocked;

    let text: string | null = null;
    if (readable) {
      text = await withDetachedDoc(noteId, (doc) => extractText(doc));
    }

    await database.bodies.put({
      noteId,
      throughSeq,
      keyEpoch,
      text: locked ? null : text,
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
        const entries = await database.outbox.orderBy("createdAt").limit(PUSH_OP_LIMIT).toArray();
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

        const response = await this.client.mutation(api.sync.push, {
          deviceId: this.device,
          ops: ops as never,
        });
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
      this.set({ state: "idle", pending: await database.outbox.count() });
    } catch {
      this.set({ state: navigator.onLine === false ? "offline" : "error" });
    } finally {
      this.draining = false;
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.drain(), this.interval);
      }
    }
  }

  /**
   * A rejected operation is dropped rather than retried forever. The two that
   * matter are a stale clock, which the client has already corrected, and a
   * stale key epoch, which means the note was locked or unlocked elsewhere and
   * the local edit has to be re-derived against the new epoch.
   */
  private async handleRejection(
    opId: string,
    kind: string,
    entityId: string,
    reason?: string,
  ): Promise<void> {
    const database = db();
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

    const local = await withDetachedDoc(noteId, (doc) =>
      Y.encodeStateAsUpdate(doc),
    );
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
  async compact(noteId: string): Promise<void> {
    const database = db();
    const note = await database.notes.get(noteId);
    const body = await database.bodies.get(noteId);
    if (!note || !body) return;
    if (body.throughSeq !== note.lastUpdateSeq) return;
    if (body.keyEpoch !== note.keyEpoch) return;
    const unpushed = await database.updates
      .where("noteId")
      .equals(noteId)
      .filter((u) => u.pushed === 0)
      .count();
    if (unpushed > 0) return;
    if (note.locked && (!note.wrappedKey || !vault.isUnlocked)) return;

    const merged = await withDetachedDoc(noteId, (doc) => Y.encodeStateAsUpdate(doc));
    let payload = merged;
    let iv: Uint8Array | undefined;
    if (note.locked && note.wrappedKey) {
      const key = await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey);
      const sealed = await seal(key, merged, ctx.yjsSnapshot(noteId, note.keyEpoch));
      payload = sealed.ct;
      iv = sealed.iv;
    }

    const referenced = await database.attachments
      .where("noteId")
      .equals(noteId)
      .primaryKeys();

    const result = await this.client.mutation(api.notes.compact, {
      noteId,
      keyEpoch: note.keyEpoch,
      coversThroughSeq: note.lastUpdateSeq,
      payload: toArrayBuffer(payload),
      size: payload.byteLength,
      ...(iv ? { iv: toArrayBuffer(iv) } : {}),
      referenced: referenced as string[],
    });
    if (result.status !== "ok") return;

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
  }

  /**
   * Fills in readings for notes whose text changed.
   *
   * Writing text deliberately leaves the reading field absent, which marks it
   * stale; this pass is what makes it current again. It does nothing at all
   * unless reading search has been turned on.
   */
  private async refreshReadings(): Promise<void> {
    if (Date.now() - this.lastReadingPass < 4_000) return;
    this.lastReadingPass = Date.now();
    const { backfillReadings, isYomiEnabled } = await import("@/lib/search/yomi");
    if (!(await isYomiEnabled())) return;
    await backfillReadings().catch(() => {});
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
      }
    }
    if (missing.length > 0) await this.fetchBodies(missing);
  }
}

function estimateSize(payload: Record<string, unknown>): number {
  const buffer = payload.payload;
  if (buffer instanceof ArrayBuffer) return buffer.byteLength + 256;
  return 512;
}
