/**
 * Writes WebP off the page's thread, for a browser whose canvas cannot
 * (Safari). Built on its own into public/webp/<version>/ by
 * scripts/build-webp-worker.mjs, next to the encoder's WebAssembly, which it
 * loads from beside itself as soon as it starts, and says when it is ready.
 * Not part of the app's bundle.
 */
import factory, { type WebPModule } from "@jsquash/webp/codec/enc/webp_enc.js";
import { defaultOptions } from "@jsquash/webp/meta.js";
import { initEmscriptenModule } from "@jsquash/webp/utils.js";

type Request = { id: number; width: number; height: number; pixels: ArrayBuffer; quality: number };
type Message =
  | { ready: true; loadMs: number }
  | { ready: false; error: string }
  | { id: number; webp: ArrayBuffer; ms: number; heap: number | null }
  | { id: number; error: string };

/**
 * libwebp's effort, from 0 to 6. At 2 a photo takes a third of the time it
 * does at the default 4, and comes out 3 to 4 per cent larger.
 */
const METHOD = 2;

/** The parts of a worker's global scope used here. */
const scope = self as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Message, transfer?: Transferable[]): void;
};

const besideMe = (file: string) => new URL(file, scope.location.href).href;

async function compile(): Promise<WebAssembly.Module> {
  const url = besideMe("webp_enc.wasm");
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    // Served without the WebAssembly type: read it whole instead.
    return WebAssembly.compile(await (await fetch(url)).arrayBuffer());
  }
}

const started = performance.now();
const encoder: Promise<WebPModule> = compile().then((compiled) =>
  // Should the compiled module fail to start, the encoder looks for its file
  // beside the worker too, not at an address of its own.
  initEmscriptenModule(factory, compiled, { locateFile: besideMe }),
);
encoder.then(
  () => scope.postMessage({ ready: true, loadMs: performance.now() - started }),
  (error: unknown) => scope.postMessage({ ready: false, error: String(error) }),
);

scope.onmessage = async (event) => {
  const { id, width, height, pixels, quality } = event.data;
  try {
    const libwebp = await encoder;
    const began = performance.now();
    const written = libwebp.encode(new Uint8ClampedArray(pixels), width, height, {
      ...defaultOptions,
      quality,
      method: METHOD,
    });
    if (!written) throw new Error("encoding failed");
    // Its own buffer, exactly as long as the file, to hand back without a copy.
    const webp = written.slice().buffer;
    const heap = (libwebp as { HEAPU8?: Uint8Array }).HEAPU8?.length ?? null;
    scope.postMessage({ id, webp, ms: performance.now() - began, heap }, [webp]);
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
};
