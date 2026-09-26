"use client";

import asset from "./webp-asset.json";

/**
 * Where images can be written as WebP. Safari (iPhone, iPad and the Mac, and
 * so a desktop shell's window there too) cannot: asked for WebP, its canvas
 * quietly writes a PNG. That is found out once, from a single pixel, rather
 * than from a full-size image every time; there, a worker running libwebp as
 * WebAssembly writes it instead ({@link encodeWebp}).
 */
let canvasWebp: Promise<boolean> | null = null;

export function canvasWritesWebp(): Promise<boolean> {
  canvasWebp ??= new Promise<boolean>((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      canvas.toBlob((blob) => resolve(blob?.type === "image/webp"), "image/webp");
    } catch {
      resolve(false);
    }
  });
  return canvasWebp;
}

/** The worker's files, under a path that changes with the encoder or the worker. */
export const WEBP_ASSET_VERSION: string = asset.version;
const WORKER_URL = `/webp/${WEBP_ASSET_VERSION}/webp-worker.js`;
const WASM_URL = `/webp/${WEBP_ASSET_VERSION}/webp_enc.wasm`;

/** Longest one image may take to encode, counted only while the page is in view. */
const ENCODE_TIMEOUT_MS = 8_000;
/** Longest the encoder may take to download and start, likewise. */
const LOAD_TIMEOUT_MS = 30_000;
/** Failed encodings in a row after which the worker is not asked again this session. */
const GIVE_UP_AFTER = 2;
/** A worker left idle this long is let go, with the memory its encoder holds. */
const IDLE_MS = 20_000;

/** What asking the worker came to, for the diagnostics in Settings. */
export type WorkerReport = {
  webp: Blob | null;
  /** Waiting for the image before, and for the worker to be ready. */
  waitedMs: number;
  /** Downloading and starting the encoder, when it started for this image. */
  loadMs?: number;
  /** Encoding, in the worker. */
  encodeMs?: number;
  /** The encoder's memory afterwards, when it says. */
  heapBytes?: number;
  /** Why there is no WebP, when there is none. */
  issue?: string;
};

type Ready = { ready: true; loadMs: number } | { ready: false; error: string };
type Reply = { id: number; webp: ArrayBuffer; ms: number; heap: number | null } | { id: number; error: string };

type Running = {
  worker: Worker;
  ready: Promise<Ready>;
  settle: (ready: Ready) => void;
  /** Not used for an image yet: the next report says how long it took to load. */
  fresh: boolean;
};

let running: Running | null = null;
let failures = 0;
/** The encoder could not be loaded: not tried again until the network is back. */
let loadBlocked = false;
let idle: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const waiting = new Map<number, (reply: Reply | null) => void>();
/** One image at a time: each holds a full-size copy of its pixels. */
let queue: Promise<unknown> = Promise.resolve();

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    loadBlocked = false;
  });
}

/** Whether asking the worker is worth it here: it can run, and has not kept failing. */
export function webpWorkerAvailable(): boolean {
  return (
    !loadBlocked &&
    failures < GIVE_UP_AFTER &&
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined"
  );
}

/** Where the worker stands, for the diagnostics in Settings. */
export function webpWorkerState(): { available: boolean; failures: number; loadBlocked: boolean } {
  return { available: webpWorkerAvailable(), failures, loadBlocked };
}

function startWorker(): Running | null {
  if (running) return running;
  let worker: Worker;
  try {
    worker = new Worker(WORKER_URL);
  } catch {
    return null;
  }
  let settle!: (ready: Ready) => void;
  const ready = new Promise<Ready>((resolve) => (settle = resolve));
  const started: Running = { worker, ready, settle, fresh: true };
  // Only this worker's messages count: one let go may still say something.
  worker.onmessage = (event: MessageEvent<Ready | Reply>) => {
    if (running !== started) return;
    const data = event.data;
    if ("ready" in data) {
      settle(data);
      return;
    }
    const done = waiting.get(data.id);
    waiting.delete(data.id);
    done?.(data);
  };
  worker.onerror = () => {
    if (running !== started) return;
    settle({ ready: false, error: "the encoder did not load" });
    stopWorker();
  };
  running = started;
  return started;
}

function stopWorker() {
  const current = running;
  running = null;
  if (idle) clearTimeout(idle);
  idle = null;
  if (!current) return;
  current.worker.terminate();
  current.settle({ ready: false, error: "the encoder was stopped" });
  for (const done of waiting.values()) done(null);
  waiting.clear();
}

/**
 * Runs `fire` after `ms` of the page being in view: iOS stops an app that is
 * not on screen, and the time it spends stopped says nothing about the
 * encoder. Returns what cancels it.
 */
function visibleTimeout(ms: number, fire: () => void): () => void {
  let remaining = ms;
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let over = false;
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const onChange = () => (hidden() ? pause() : run());
  // Once, whichever comes first: it fires, or it is cancelled.
  const end = () => {
    over = true;
    pause();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onChange);
  };
  const run = () => {
    if (timer || over) return;
    since = performance.now();
    timer = setTimeout(() => {
      timer = null;
      end();
      fire();
    }, remaining);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(0, remaining - (performance.now() - since));
  };
  if (!hidden()) run();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onChange);
  return end;
}

/**
 * Writes pixels as WebP in the worker, at `quality` (0 to 1). `webp` is null
 * when that cannot be done here, and the caller then writes its fallback
 * format. The pixels are handed over, not copied, so `image` is unusable
 * afterwards. `trial`: a try from the diagnostics, whose failures do not
 * count against the worker.
 */
export function encodeWebp(
  image: ImageData,
  quality: number,
  opts: { timeoutMs?: number; trial?: boolean } = {},
): Promise<WorkerReport> {
  const asked = performance.now();
  const run = queue.then(() =>
    encodeOnce(image, quality, opts.timeoutMs ?? ENCODE_TIMEOUT_MS, opts.trial === true, asked),
  );
  queue = run.catch(() => undefined);
  return run;
}

async function encodeOnce(
  image: ImageData,
  quality: number,
  timeoutMs: number,
  trial: boolean,
  asked: number,
): Promise<WorkerReport> {
  const since = () => performance.now() - asked;
  if (!webpWorkerAvailable()) return { webp: null, waitedMs: since(), issue: "unavailable" };
  if (idle) clearTimeout(idle);
  idle = null;
  const encoder = startWorker();
  if (!encoder) {
    loadBlocked = true;
    return { webp: null, waitedMs: since(), issue: "no worker" };
  }

  const ready = await new Promise<Ready>((resolve) => {
    const cancel = visibleTimeout(LOAD_TIMEOUT_MS, () =>
      resolve({ ready: false, error: "the encoder took too long to load" }),
    );
    void encoder.ready.then((answer) => {
      cancel();
      resolve(answer);
    });
  });
  if (!ready.ready) {
    // Most likely offline with nothing cached yet: not the encoder's fault,
    // and tried again once the network is back.
    loadBlocked = true;
    stopWorker();
    return { webp: null, waitedMs: since(), issue: ready.error };
  }
  const loadMs = encoder.fresh ? ready.loadMs : undefined;
  encoder.fresh = false;
  const waitedMs = since();

  const id = nextId++;
  let timedOut = false;
  const reply = await new Promise<Reply | null>((resolve) => {
    const cancel = visibleTimeout(timeoutMs, () => {
      // Stuck, or far too slow here: started afresh next time, if at all.
      timedOut = true;
      waiting.delete(id);
      stopWorker();
      resolve(null);
    });
    waiting.set(id, (answer) => {
      cancel();
      resolve(answer);
    });
    try {
      const pixels = image.data.buffer as ArrayBuffer;
      encoder.worker.postMessage(
        { id, width: image.width, height: image.height, pixels, quality: Math.round(quality * 100) },
        [pixels],
      );
    } catch (error) {
      cancel();
      waiting.delete(id);
      resolve({ id, error: String(error) });
    }
  });

  if (running === encoder) idle = setTimeout(stopWorker, IDLE_MS);
  if (!reply || "error" in reply) {
    if (!trial) failures += 1;
    // A worker that failed an image is not trusted with the next one.
    if (reply) stopWorker();
    return {
      webp: null,
      waitedMs,
      loadMs,
      issue: timedOut ? "timed out" : reply && "error" in reply ? reply.error : "the encoder stopped",
    };
  }
  failures = 0;
  return {
    webp: new Blob([reply.webp], { type: "image/webp" }),
    waitedMs,
    loadMs,
    encodeMs: reply.ms,
    ...(reply.heap === null ? {} : { heapBytes: reply.heap }),
  };
}

/**
 * Where the canvas cannot write WebP, fetches the encoder's files while
 * there is a network, so the service worker has them for the first image, an
 * image added offline included. Once a session.
 */
let warmed = false;

export async function warmWebpEncoder(): Promise<void> {
  if (warmed || typeof navigator === "undefined" || !navigator.onLine) return;
  if (await canvasWritesWebp()) return;
  warmed = true;
  await Promise.all([fetch(WORKER_URL), fetch(WASM_URL)].map((request) => request.catch(() => undefined)));
}

/** Forgets what was found out, as if the page had just loaded: for tests. */
export function forgetWebpSupport(): void {
  canvasWebp = null;
  stopWorker();
  failures = 0;
  loadBlocked = false;
  warmed = false;
  queue = Promise.resolve();
}
