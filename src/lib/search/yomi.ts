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
 * The dictionary behind this is a 17 MB download, so nothing starts until
 * something actually needs a reading. Once fetched it is cached by the service
 * worker and stays available offline.
 */

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
  };
  worker = created;
  return created;
}

function send(request: { type: "warm" } | { type: "readings"; texts: string[] }) {
  const active = ensureWorker();
  if (!active) return Promise.reject(new Error("worker unavailable"));
  const id = nextId++;
  if (state === "idle") setState("loading");
  return new Promise<string[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage({ ...request, id });
  });
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
 * Opt-in on purpose: the dictionary is a 17 MB download, and silently spending
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

export async function disableYomi(): Promise<void> {
  await setMeta(META.yomi, false);
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

/** Fills in readings for every note that does not have one yet. */
export async function backfillReadings(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
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
