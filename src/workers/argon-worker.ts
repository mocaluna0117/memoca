/**
 * The vault's password worked into a key (Argon2id), off the page's thread:
 * a second or two of work, with 64 MB of memory, that froze the page while
 * it ran, its spinner with it. Built by scripts/build-argon-worker.mjs into
 * public/argon/<version>/, one classic worker file holding hash-wasm and its
 * WebAssembly, which loads nothing of its own (see yomi-worker.js on why).
 *
 * in   { id, password, salt: Uint8Array, m, t, p, length }
 * out  { id, raw: Uint8Array } | { id, error: string }
 */
import { argon2id } from "hash-wasm";

type Ask = { id: number; password: string; salt: Uint8Array; m: number; t: number; p: number; length: number };

self.onmessage = async (event: MessageEvent<Ask>) => {
  const { id, password, salt, m, t, p, length } = event.data;
  try {
    const raw = await argon2id({
      password,
      salt,
      parallelism: p,
      iterations: t,
      memorySize: m,
      hashLength: length,
      outputType: "binary",
    });
    (self as unknown as Worker).postMessage({ id, raw }, [raw.buffer]);
  } catch (cause) {
    (self as unknown as Worker).postMessage({ id, error: String(cause) });
  }
};
