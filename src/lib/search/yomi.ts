"use client";

import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";

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
 * The dictionary behind this is an 11 MB download, so nothing starts until
 * something actually needs a reading. Once fetched it is cached by the service
 * worker and stays available offline.
 *
 * Used only while searching: the readings of notes written since are worked
 * out when something is searched for in kana (see useSearch), not in the
 * background, and the dictionary, loaded into a worker for it, is let go of
 * from memory once it has not been asked anything for a while.
 *
 * Kept on the device only if the person chose so (META.yomiKeep). As it
 * starts, it is downloaded when they turn it on to search and kept nowhere:
 * in the worker's memory alone, gone a minute after its last use. The
 * readings worked out with it are kept (they are small), so notes already
 * read are found by their reading with no dictionary at all.
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

/** Whether the dictionary is kept on this device; downloaded for each use otherwise. */
export async function isYomiKept(): Promise<boolean> {
  return getMeta<boolean>(META.yomiKeep, false);
}

async function send(request: { type: "warm" } | { type: "readings"; texts: string[] }) {
  const keep = await isYomiKept();
  const active = ensureWorker();
  if (!active) throw new Error("worker unavailable");
  const id = nextId++;
  if (idle) clearTimeout(idle);
  idle = null;
  if (state === "idle" || state === "unavailable") setState("loading");
  return new Promise<string[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage({ ...request, id, keep });
  });
}

/** Whether the dictionary is in memory now (or on its way), to be used with no download. */
export function isYomiLoaded(): boolean {
  return worker !== null && (state === "ready" || state === "loading");
}

/** Lets the dictionary go from memory now, rather than a minute after its last use. */
export function releaseYomi(): void {
  releaseWorker();
}

/** Where the service worker keeps the dictionary (src/app/sw.ts). */
const DICTIONARY_CACHE = "memoca-yomi";

/** Deletes the dictionary kept on this device, if any. */
async function deleteKeptDictionary(): Promise<void> {
  try {
    await caches.delete(DICTIONARY_CACHE);
  } catch {
    // No Cache Storage here (not a secure context): nothing was kept in it.
  }
}

/**
 * Keeps the dictionary on this device, or not. Not kept, what is kept of it
 * goes now, and the one in memory, loaded to be kept, with it.
 */
export async function setYomiKept(keep: boolean): Promise<void> {
  await setMeta(META.yomiKeep, keep);
  releaseWorker();
  if (!keep) await deleteKeptDictionary();
}

/**
 * Deletes a dictionary kept on this device that is not to be kept: one kept
 * before the choice was there (when it always was), or one whose deletion did
 * not finish. Once when the app starts.
 */
export async function tidyYomi(): Promise<void> {
  if (!(await isYomiKept())) await deleteKeptDictionary();
}

/**
 * The readings of notes written since, worked out for a search in kana: with
 * the dictionary kept on the device, or in memory now; never a download no one
 * asked for (the person turns it on for that, see the search page).
 */
export async function readingsForSearch(): Promise<void> {
  if (!(await isYomiEnabled())) return;
  if ((await isYomiKept()) || isYomiLoaded()) await backfillReadings();
}

/** Starts fetching the dictionary without asking for any reading yet. */
export async function warmYomi(): Promise<boolean> {
  try {
    await send({ type: "warm" });
    return true;
  } catch {
    return false;
  }
}

export async function readingsFor(texts: string[]): Promise<string[] | null> {
  if (texts.length === 0) return [];
  try {
    return await send({ type: "readings", texts });
  } catch {
    return null;
  }
}

/** True for a query worth looking up by reading: kana, with no kanji in it. */
export function isKanaQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 2) return false;
  return /^[ぁ-ゟァ-ヿーー\s]+$/.test(trimmed);
}

/* ------------------------------------------------------------- opt-in state */

/** Notes whose reading is computed in one round. */
const BACKFILL_BATCH = 40;

export async function isYomiEnabled(): Promise<boolean> {
  return getMeta<boolean>(META.yomi, false);
}

/**
 * Turns reading search on, downloading the dictionary and filling in the
 * readings of everything already stored.
 *
 * Opt-in on purpose: the dictionary is an 11 MB download, and silently spending
 * someone's mobile data on a feature they may not want is not acceptable.
 */
export async function enableYomi(
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  if (!(await warmYomi())) return false;
  await setMeta(META.yomi, true);
  await backfillReadings(onProgress);
  return true;
}

/**
 * Turns reading search off: the dictionary, out of memory and off the device
 * (the service worker's copy, 11 MB), and the readings worked out with it.
 * Turned on again, the dictionary is downloaded again.
 */
export async function disableYomi(): Promise<void> {
  await setMeta(META.yomi, false);
  releaseWorker();
  await deleteKeptDictionary();
  // The readings are derived data; drop them so nothing stale is searched.
  const database = db();
  const rows = await database.bodies.toArray();
  for (const row of rows) {
    if (row.reading !== undefined) {
      await database.bodies.update(row.noteId, { reading: undefined });
    }
  }
}

/** The text a note's reading is computed from: its title and its body. */
export async function readingSourceFor(noteId: string): Promise<string | null> {
  const database = db();
  const note = await database.notes.get(noteId);
  const body = await database.bodies.get(noteId);
  if (!note || note.locked) return null;
  const text = body?.text ?? "";
  return `${note.title ?? ""}\n${text}`.trim();
}

/** Computes and stores the reading for one note, if the feature is on. */
export async function refreshReading(noteId: string): Promise<void> {
  if (!(await isYomiEnabled())) return;
  const source = await readingSourceFor(noteId);
  if (source === null) return;
  if (source.length === 0) {
    await db().bodies.update(noteId, { reading: "" });
    return;
  }
  const readings = await readingsFor([source]);
  if (readings) await db().bodies.update(noteId, { reading: readings[0] ?? "" });
}

/** The pass filling in readings now, for another asked for meanwhile to wait on rather than repeat. */
let filling: Promise<void> | null = null;

/** Fills in readings for every note that does not have one yet. */
export function backfillReadings(onProgress?: (done: number, total: number) => void): Promise<void> {
  if (!filling) {
    filling = fill(onProgress).finally(() => {
      filling = null;
    });
  }
  return filling;
}

async function fill(onProgress?: (done: number, total: number) => void): Promise<void> {
  if (!(await isYomiEnabled())) return;
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
    if (!readings) return;
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
