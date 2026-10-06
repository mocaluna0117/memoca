"use client";

import { db } from "@/lib/db";

/**
 * What the worker sends back. It lives in `public/yomi-worker.js` as plain
 * JavaScript, so this is the only place the protocol is described in types.
 */
type YomiResponse =
  | { type: "ready"; id: number }
  | { type: "readings"; id: number; readings: string[] }
  | { type: "error"; id: number; message: string };

/**
 * Reading lookup for Japanese text, so a note written in kanji can be found by
 * typing how it sounds.
 *
 * Turned on by the person, on the search page ("読みでも探す"), for as long
 * as this page is open: never on its own, as it is an 11 MB download. On, the
 * readings of notes not read yet are worked out, and found as they are. The
 * dictionary for that is downloaded each time it is needed and kept nowhere:
 * fetched past every cache into a worker's memory, gone a minute after its last
 * use (or as soon as it is turned off). The readings worked out are kept (they
 * are small), so turned on again with every note read, nothing is downloaded.
 */

/** How long the dictionary stays loaded after the last reading asked of it. */
const IDLE_MS = 60_000;
let idle: ReturnType<typeof setTimeout> | null = null;

/** The worker ended, the dictionary out of memory: loaded again when next needed. */
function releaseWorker() {
  if (idle) clearTimeout(idle);
  idle = null;
  worker?.terminate();
  worker = null;
  for (const waiting of pending.values()) waiting.reject(new Error("released"));
  pending.clear();
  setState("idle");
}

/** Lets the dictionary go a while after the last reading asked of it. */
function releaseLater() {
  if (idle) clearTimeout(idle);
  idle = pending.size === 0 ? setTimeout(releaseWorker, IDLE_MS) : null;
}

type Pending = {
  resolve: (readings: string[]) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const listeners = new Set<(state: YomiState) => void>();

export type YomiState = "idle" | "loading" | "ready" | "unavailable";
let state: YomiState = "idle";

function setState(next: YomiState) {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener(state);
}

export function yomiState(): YomiState {
  return state;
}

export function onYomiState(listener: (state: YomiState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    setState("unavailable");
    return null;
  }
  // A static path, not a bundled module: see the comment in the worker itself.
  const created = new Worker("/yomi-worker.js");
  created.onmessage = (event: MessageEvent<YomiResponse>) => {
    const message = event.data;
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    releaseLater();
    if (message.type === "error") {
      setState("unavailable");
      waiting?.reject(new Error(message.message));
      return;
    }
    setState("ready");
    if (message.type === "readings") waiting?.resolve(message.readings);
    else waiting?.resolve([]);
  };
  created.onerror = () => {
    setState("unavailable");
    for (const waiting of pending.values()) waiting.reject(new Error("worker failed"));
    pending.clear();
    // Tried afresh next time (once the network is back, say).
    worker?.terminate();
    worker = null;
  };
  worker = created;
  return created;
}

async function send(request: { type: "warm" } | { type: "readings"; texts: string[] }) {
  const active = ensureWorker();
  if (!active) throw new Error("worker unavailable");
  const id = nextId++;
  if (idle) clearTimeout(idle);
  idle = null;
  if (state === "idle" || state === "unavailable") setState("loading");
  return new Promise<string[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage({ ...request, id });
  });
}

/** The readings of texts, in katakana; throws when the dictionary cannot be had. */
async function readingsFor(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  return send({ type: "readings", texts });
}

/** True for a query worth looking up by reading: kana, with no kanji in it. */
export function isKanaQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 2) return false;
  return /^[ぁ-ゟァ-ヿーー\s]+$/.test(trimmed);
}

/** The pass filling in readings now, for another asked for meanwhile to wait on rather than repeat. */
let filling: Promise<void> | null = null;

/** Notes whose reading is computed in one round. */
const BACKFILL_BATCH = 40;

/** The text a note's reading is computed from: its title and its body. */
async function readingSourceFor(noteId: string): Promise<string | null> {
  const database = db();
  const note = await database.notes.get(noteId);
  const body = await database.bodies.get(noteId);
  if (!note || note.locked) return null;
  const text = body?.text ?? "";
  return `${note.title ?? ""}\n${text}`.trim();
}

/** Fills in readings for every note that does not have one yet; throws when the dictionary cannot be had. */
function backfillReadings(onProgress?: (done: number, total: number) => void): Promise<void> {
  if (!filling) {
    filling = fill(onProgress).finally(() => {
      filling = null;
    });
  }
  return filling;
}

async function fill(onProgress?: (done: number, total: number) => void): Promise<void> {
  const database = db();
  const missing = (await database.bodies.toArray()).filter(
    (row) => row.reading === undefined || row.reading === null,
  );
  if (missing.length === 0) return;

  let done = 0;
  for (let at = 0; at < missing.length; at += BACKFILL_BATCH) {
    const slice = missing.slice(at, at + BACKFILL_BATCH);
    const sources = await Promise.all(
      slice.map((row) => readingSourceFor(row.noteId)),
    );
    const wanted = slice
      .map((row, index) => ({ row, source: sources[index] }))
      .filter((entry): entry is { row: typeof slice[number]; source: string } =>
        entry.source !== null,
      );

    const readings = await readingsFor(wanted.map((entry) => entry.source));
    for (const [index, entry] of wanted.entries()) {
      await database.bodies.update(entry.row.noteId, { reading: readings[index] ?? "" });
    }
    // Locked notes have no readable source; mark them so they stop being
    // rescanned on every pass.
    for (const row of slice) {
      if (sources[slice.indexOf(row)] === null) {
        await database.bodies.update(row.noteId, { reading: "" });
      }
    }
    done += slice.length;
    onProgress?.(Math.min(done, missing.length), missing.length);
    // Let the interface breathe between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/* ------------------------------------------------------- turned on, or off */

let on = false;
const onListeners = new Set<() => void>();

/** Whether reading search is turned on, for as long as this page is open. */
export function isYomiOn(): boolean {
  return on;
}

export function onYomiOn(listener: () => void): () => void {
  onListeners.add(listener);
  return () => onListeners.delete(listener);
}

function setOn(next: boolean) {
  if (on === next) return;
  on = next;
  for (const listener of onListeners) listener();
}

/**
 * Turns reading search on: the readings of notes not read yet worked out,
 * the dictionary downloaded for it if there are any. Not to be had (no
 * network, say), it is off again, and the reason thrown.
 */
export async function turnYomiOn(onProgress?: (done: number, total: number) => void): Promise<void> {
  setOn(true);
  try {
    await backfillReadings(onProgress);
  } catch (cause) {
    setOn(false);
    releaseWorker();
    throw cause;
  }
}

/** Turns reading search off, the dictionary out of memory at once. */
export function turnYomiOff(): void {
  setOn(false);
  releaseWorker();
}

/**
 * With reading search on, the readings of notes written since worked out for
 * a search in kana (the dictionary downloaded again if it has been let go of).
 * A failure leaves those notes to the next search.
 */
export async function readingsForSearch(): Promise<void> {
  if (!on) return;
  await backfillReadings().catch(() => {});
}

/**
 * Deletes the dictionary that earlier versions kept on the device (in the
 * service worker's cache), which nothing keeps now. Once when the app starts.
 */
export async function tidyYomi(): Promise<void> {
  try {
    await caches.delete("memoca-yomi");
  } catch {
    // No Cache Storage here (not a secure context): nothing was kept in it.
  }
}
