import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import asset from "@/lib/media/webp-asset.json";
import {
  WEBP_ASSET_VERSION,
  encodeWebp,
  forgetWebpSupport,
  webpWorkerAvailable,
  webpWorkerState,
} from "@/lib/media/webp-encoder";
import { webpSourceHash } from "../scripts/webp-source-hash.mjs";

type Sent = { id: number; width: number; height: number; pixels: ArrayBuffer; quality: number };

/**
 * Stands in for the WebAssembly worker. `loads` is what it says once started
 * ("ready", "fails" to load, or "breaks" with an error event); `answer` what
 * it does with each image; every worker made is kept in `made`.
 */
let loads: "ready" | "fails" | "breaks";
let answer: "webp" | "error" | "nothing";
let made: FakeWorker[];

class FakeWorker {
  posted: { message: Sent; transfer: Transferable[] }[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    made.push(this);
    const how = loads;
    queueMicrotask(() => {
      if (how === "breaks") this.onerror?.(new Event("error"));
      else this.say(how === "ready" ? { ready: true, loadMs: 3 } : { ready: false, error: "offline" });
    });
  }
  say(data: unknown) {
    queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
  }
  postMessage(message: Sent, transfer: Transferable[]) {
    this.posted.push({ message, transfer });
    if (answer === "nothing") return;
    this.say(
      answer === "webp"
        ? { id: message.id, webp: new TextEncoder().encode("RIFF....WEBP").buffer, ms: 5, heap: 1_234 }
        : { id: message.id, error: "encoding failed" },
    );
  }
  terminate() {
    this.terminated = true;
  }
}

const pixels = (width = 2, height = 2) =>
  ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData;
const sentCount = () => made.reduce((sum, worker) => sum + worker.posted.length, 0);
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  loads = "ready";
  answer = "webp";
  made = [];
  vi.stubGlobal("Worker", FakeWorker);
  forgetWebpSupport();
});

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("writing WebP in the worker", () => {
  test("hands the pixels over rather than copying them, and says where the time went", async () => {
    const image = pixels(3, 2);
    const buffer = image.data.buffer;
    const report = await encodeWebp(image, 0.82);
    expect(report.webp?.type).toBe("image/webp");
    expect(report.webp?.size).toBe(12);
    expect(report).toMatchObject({ loadMs: 3, encodeMs: 5, heapBytes: 1_234 });
    const [sent] = made[0]!.posted;
    expect(sent!.message).toMatchObject({ width: 3, height: 2, quality: 82 });
    expect(sent!.message.pixels).toBe(buffer);
    expect(sent!.transfer[0]).toBe(buffer);
    expect(made[0]!.url).toBe(`/webp/${WEBP_ASSET_VERSION}/webp-worker.js`);
  });

  test("keeps one worker for image after image, and reports its loading once", async () => {
    const first = await encodeWebp(pixels(), 0.8);
    const second = await encodeWebp(pixels(), 0.8);
    expect(made).toHaveLength(1);
    expect(made[0]!.posted).toHaveLength(2);
    expect(first.loadMs).toBe(3);
    expect(second.loadMs).toBeUndefined();
  });

  test("sends it one image at a time", async () => {
    answer = "nothing";
    const first = encodeWebp(pixels(), 0.8, { timeoutMs: 50 });
    const second = encodeWebp(pixels(), 0.8, { timeoutMs: 50 });
    await later(10);
    expect(sentCount()).toBe(1);
    expect((await first).webp).toBeNull();
    answer = "webp";
    expect((await second).webp?.type).toBe("image/webp");
  });

  test("an image that takes too long falls back, and the stuck worker is let go", async () => {
    answer = "nothing";
    expect(await encodeWebp(pixels(), 0.8, { timeoutMs: 20 })).toMatchObject({ webp: null, issue: "timed out" });
    expect(made[0]!.terminated).toBe(true);
    answer = "webp";
    expect((await encodeWebp(pixels(), 0.8)).webp?.type).toBe("image/webp");
    expect(made).toHaveLength(2);
  });

  test("time the page spends out of view does not count", async () => {
    answer = "nothing";
    let done = false;
    const pending = encodeWebp(pixels(), 0.8, { timeoutMs: 60 }).then((report) => {
      done = true;
      return report;
    });
    await later(15);
    // The app is put away: iOS stops it, and its timers with it.
    setVisibility("hidden");
    await later(120);
    expect(done).toBe(false);
    setVisibility("visible");
    expect((await pending).issue).toBe("timed out");
  });

  test("a timeout that has fired stays done, whatever the page does afterwards", async () => {
    answer = "nothing";
    await encodeWebp(pixels(), 0.8, { timeoutMs: 20 });
    const next = encodeWebp(pixels(), 0.8, { timeoutMs: 1_000 });
    await later(10);
    // Away and back: the first image's timer must not come back to life.
    setVisibility("hidden");
    setVisibility("visible");
    await later(40);
    const current = made.at(-1)!;
    expect(current.terminated).toBe(false);
    current.say({ id: current.posted.at(-1)!.message.id, webp: new ArrayBuffer(4), ms: 1, heap: null });
    expect((await next).webp?.size).toBe(4);
  });

  test("two failed images in a row, and it is not asked again; one that works in between starts the count again", async () => {
    answer = "error";
    await encodeWebp(pixels(), 0.8);
    answer = "webp";
    await encodeWebp(pixels(), 0.8);
    answer = "error";
    await encodeWebp(pixels(), 0.8);
    expect(webpWorkerAvailable()).toBe(true);
    await encodeWebp(pixels(), 0.8);
    expect(webpWorkerAvailable()).toBe(false);
    answer = "webp";
    const sent = sentCount();
    expect((await encodeWebp(pixels(), 0.8)).webp).toBeNull();
    expect(sentCount()).toBe(sent);
  });

  test("a worker that failed an image is not used for the next", async () => {
    answer = "error";
    await encodeWebp(pixels(), 0.8);
    expect(made[0]!.terminated).toBe(true);
    answer = "webp";
    await encodeWebp(pixels(), 0.8);
    expect(made).toHaveLength(2);
  });

  test("an encoder that cannot load is not held against it, and is tried again once the network is back", async () => {
    loads = "fails";
    expect(await encodeWebp(pixels(), 0.8)).toMatchObject({ webp: null, issue: "offline" });
    expect(webpWorkerState()).toMatchObject({ available: false, failures: 0, loadBlocked: true });
    loads = "ready";
    expect((await encodeWebp(pixels(), 0.8)).webp).toBeNull();
    expect(made).toHaveLength(1);
    window.dispatchEvent(new Event("online"));
    expect((await encodeWebp(pixels(), 0.8)).webp?.type).toBe("image/webp");
  });

  test("a worker that breaks while loading falls back", async () => {
    loads = "breaks";
    expect((await encodeWebp(pixels(), 0.8, { timeoutMs: 60_000 })).webp).toBeNull();
    expect(made[0]!.terminated).toBe(true);
  });

  test("a message that cannot be sent falls back, and leaves nothing behind to stop the next worker", async () => {
    const image = pixels();
    const post = FakeWorker.prototype.postMessage;
    vi.spyOn(FakeWorker.prototype, "postMessage").mockImplementationOnce(() => {
      throw new DOMException("could not be cloned", "DataCloneError");
    });
    expect((await encodeWebp(image, 0.8, { timeoutMs: 30 })).webp).toBeNull();
    vi.mocked(FakeWorker.prototype.postMessage).mockImplementation(post);
    answer = "nothing";
    const next = encodeWebp(pixels(), 0.8, { timeoutMs: 200 });
    await later(60);
    // Long past when the first image's timer would have fired.
    expect(made.at(-1)!.terminated).toBe(false);
    answer = "webp";
    made.at(-1)!.say({ id: made.at(-1)!.posted.at(-1)!.message.id, webp: new ArrayBuffer(4), ms: 1, heap: null });
    expect((await next).webp?.size).toBe(4);
  });

  test("a late word from a worker let go does not stop the one after it", async () => {
    answer = "nothing";
    await encodeWebp(pixels(), 0.8, { timeoutMs: 20 });
    const old = made[0]!;
    const next = encodeWebp(pixels(), 0.8, { timeoutMs: 1_000 });
    // The new worker is up, and has the image.
    await later(10);
    old.onerror?.(new Event("error"));
    const current = made.at(-1)!;
    expect(current).not.toBe(old);
    expect(current.terminated).toBe(false);
    current.say({ id: current.posted.at(-1)!.message.id, webp: new ArrayBuffer(4), ms: 1, heap: null });
    expect((await next).webp?.size).toBe(4);
  });

  test("a worker left idle is let go, with the memory it holds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const report = encodeWebp(pixels(), 0.8);
    await vi.advanceTimersByTimeAsync(10);
    expect((await report).webp?.type).toBe("image/webp");
    expect(made[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(made[0]!.terminated).toBe(true);
  });

  test("a try from the diagnostics that fails does not count against it", async () => {
    answer = "error";
    await encodeWebp(pixels(), 0.8, { trial: true });
    await encodeWebp(pixels(), 0.8, { trial: true });
    expect(webpWorkerState().failures).toBe(0);
  });

  test("where there are no workers, or no WebAssembly, it is not tried", async () => {
    vi.stubGlobal("Worker", undefined);
    expect(webpWorkerAvailable()).toBe(false);
    expect((await encodeWebp(pixels(), 0.8)).webp).toBeNull();
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("WebAssembly", undefined);
    expect(webpWorkerAvailable()).toBe(false);
  });

  test("a worker that cannot even be made is not tried again until the network is back", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    expect((await encodeWebp(pixels(), 0.8)).webp).toBeNull();
    expect(webpWorkerState().loadBlocked).toBe(true);
  });
});

describe("the worker's files", () => {
  test("are under the version of the encoder they were built from", () => {
    const { version } = JSON.parse(
      readFileSync(join(__dirname, "../node_modules/@jsquash/webp/package.json"), "utf8"),
    ) as { version: string };
    expect(WEBP_ASSET_VERSION.startsWith(`${version}-`)).toBe(true);
  });

  test("get a new version whenever what they are built from changes", () => {
    // Cached as immutable: a changed worker under the old path would never
    // reach anyone. Bump the version in src/lib/media/webp-asset.json and
    // record `node scripts/webp-source-hash.mjs` there.
    expect(asset.sourceHash).toBe(webpSourceHash(join(__dirname, "..")));
  });
});
