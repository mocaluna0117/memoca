import { afterEach, describe, expect, test, vi } from "vitest";
import { argon2id } from "hash-wasm";
import { argonKey, seal, open } from "@/lib/crypto/primitives";

const PARAMS = { m: 1024, t: 1, p: 1 };
const salt = new Uint8Array(16).fill(3);

afterEach(() => vi.unstubAllGlobals());

/** Whether two keys are the same: what one seals, the other opens. */
async function same(a: CryptoKey, b: CryptoKey) {
  const sealed = await seal(a, new TextEncoder().encode("中身"), "test");
  return new TextDecoder().decode(await open(b, sealed.ct, sealed.iv, "test"));
}

describe("the vault's password worked into a key", () => {
  test("in a worker where there is one, the same key as on the page's thread", async () => {
    const asked: unknown[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      terminated = false;
      postMessage(data: { password: string; salt: Uint8Array; m: number; t: number; p: number; length: number }) {
        asked.push(data);
        void argon2id({
          password: data.password,
          salt: data.salt,
          parallelism: data.p,
          iterations: data.t,
          memorySize: data.m,
          hashLength: data.length,
          outputType: "binary",
        }).then((raw) => this.onmessage?.({ data: { id: 1, raw } } as MessageEvent));
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const inWorker = await argonKey("パスワード", salt, PARAMS);
    expect(asked).toHaveLength(1);
    vi.unstubAllGlobals();
    vi.stubGlobal("Worker", undefined);
    const onPage = await argonKey("パスワード", salt, PARAMS);
    expect(await same(inWorker, onPage)).toBe("中身");
  });

  test("on the page's thread when the worker cannot start (offline, its script never kept)", async () => {
    class BrokenWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      postMessage() {
        queueMicrotask(() => this.onerror?.(new Event("error", { cancelable: true })));
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", BrokenWorker);
    const key = await argonKey("パスワード", salt, PARAMS);
    vi.stubGlobal("Worker", undefined);
    expect(await same(key, await argonKey("パスワード", salt, PARAMS))).toBe("中身");
  });
});
