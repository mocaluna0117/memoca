import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ReadTrace, type WriteTrace, prepareImage } from "@/lib/media/compress";
import { mustFit, writePlan } from "@/lib/media/prepare-plan";
import {
  forgetWebpSupport,
  prepareInWorker,
  webpWorkerState,
  workerPreparesImages,
} from "@/lib/media/webp-encoder";

/**
 * Stands in for the worker that prepares images: what it says of each file
 * given it (`answer`), and every worker made (`made`).
 */
type Answer = "prepared" | "original" | "unsupported" | "error" | "nothing";
let answer: Answer;
let made: FakeWorker[];
const read = { width: 4000, height: 3000, ms: 12, kind: "photo" as const, flat: 0.1, sampleMs: 2 };
const write = {
  width: 2048,
  height: 1536,
  by: "worker-canvas" as const,
  type: "image/webp",
  bytes: 10,
  drawMs: 3,
  ms: 40,
};

class FakeWorker {
  posted: Record<string, unknown>[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() {
    made.push(this);
    queueMicrotask(() => this.say({ ready: true, loadMs: 1 }));
  }
  say(data: unknown) {
    queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
  }
  postMessage(message: Record<string, unknown>) {
    this.posted.push(message);
    const id = message.id;
    switch (answer) {
      case "prepared":
        this.say({
          id,
          read,
          writes: [write],
          prepared: { blob: new Blob([new Uint8Array(10)], { type: "image/webp" }), mime: "image/webp", width: 2048, height: 1536 },
        });
        break;
      case "original":
        this.say({ id, read, writes: [write], original: true, width: 400, height: 300 });
        break;
      case "unsupported":
        this.say({ id, unsupported: true });
        break;
      case "error":
        this.say({ id, error: "boom" });
        break;
      case "nothing":
        break;
    }
  }
  terminate() {}
}

const file = (type = "image/png", size = 100_000) =>
  new File([new Uint8Array(size)], "写真.png", { type });

beforeEach(() => {
  answer = "prepared";
  made = [];
  forgetWebpSupport();
  vi.stubGlobal("Worker", FakeWorker);
  // What every current browser gives a worker, and jsdom does not.
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close() {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("an image prepared in the worker", () => {
  test("is read, judged, drawn and written there, and the page takes what it wrote", async () => {
    const reads: ReadTrace[] = [];
    const writes: WriteTrace[] = [];
    const prepared = await prepareImage(file(), {
      maxBytes: 5_000_000,
      onRead: (trace) => reads.push(trace),
      onWrite: (trace) => writes.push(trace),
    });
    expect(prepared).toMatchObject({ mime: "image/webp", width: 2048, height: 1536 });
    expect(made).toHaveLength(1);
    expect(made[0]!.posted[0]).toMatchObject({ kind: "prepare", type: "image/png", size: 100_000, maxBytes: 5_000_000 });
    expect(reads).toEqual([read]);
    expect(writes).toEqual([write]);
  });

  test("the original is kept where the worker found nothing smaller", async () => {
    answer = "original";
    const original = file();
    const prepared = await prepareImage(original);
    expect(prepared.blob).toBe(original);
    expect(prepared).toMatchObject({ width: 400, height: 300 });
  });

  test("one the worker cannot read is refused unless the server takes it as it is", async () => {
    answer = "unsupported";
    await expect(prepareImage(file("image/heic"))).rejects.toThrow("unsupported image");
    const kept = await prepareImage(file("image/jpeg"));
    expect(kept.mime).toBe("image/jpeg");
  });

  test("where the worker fails, the page does it itself, and after twice the worker is not asked", async () => {
    answer = "error";
    // The page's own path, which jsdom cannot run: asked for, and it throws here.
    vi.stubGlobal("createImageBitmap", async () => {
      throw new DOMException("no canvas here");
    });
    expect(await prepareInWorker(file())).toBeNull();
    expect(await prepareInWorker(file())).toBeNull();
    expect(webpWorkerState().failures).toBe(2);
    expect(workerPreparesImages()).toBe(false);
    expect(await prepareInWorker(file())).toBeNull();
    expect(made).toHaveLength(2);
  });

  test("one that takes too long is given up on, the worker let go", async () => {
    vi.useFakeTimers();
    answer = "nothing";
    const asked = prepareInWorker(file(), { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await asked).toBeNull();
    expect(webpWorkerState().failures).toBe(1);
  });

  test("where workers have no canvas (an old browser), it is not tried", async () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    expect(workerPreparesImages()).toBe(false);
    expect(await prepareInWorker(file())).toBeNull();
    expect(made).toHaveLength(0);
  });
});

describe("how an image is written, decided apart from the drawing", () => {
  test("a photo: at 2048, then smaller and lower in quality, twice at most", () => {
    const plan = writePlan({ width: 4000, height: 3000 }, "photo");
    expect(plan.map((step) => step.fit.maxEdge)).toEqual([2048, 1600, 1280]);
    expect(plan.map((step) => Math.round(step.quality * 100))).toEqual([75, 65, 55]);
  });

  test("a screen kept at its own size, then as a photo would be", () => {
    const plan = writePlan({ width: 1200, height: 800 }, "screen");
    expect(plan[0]!.fit.maxEdge).toBeGreaterThanOrEqual(1200);
    expect(plan.slice(1).map((step) => step.fit.maxEdge)).toEqual([]);
  });

  test("what is written has to be used when the original is over the limit, or not a type the server takes", () => {
    expect(mustFit({ size: 100, type: "image/png" }, 1_000)).toBe(false);
    expect(mustFit({ size: 2_000, type: "image/png" }, 1_000)).toBe(true);
    expect(mustFit({ size: 100, type: "image/heic" })).toBe(true);
  });
});
