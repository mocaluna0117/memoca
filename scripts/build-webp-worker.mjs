/**
 * Builds the WebP worker into public/webp/<version>/, next to the encoder's
 * WebAssembly, for browsers whose canvas cannot write WebP (Safari).
 *
 * Built rather than kept in the repository, like the kuromoji dictionary: it
 * is made from a dependency. The version in the path (src/lib/media/
 * webp-asset.json) changes with the encoder or the worker, so a new build
 * never meets an old file cached as immutable.
 */
import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "src/lib/media/webp-asset.json"), "utf8"));
const encoder = join(root, "node_modules/@jsquash/webp");
const out = join(root, "public/webp", version);

await rm(join(root, "public/webp"), { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, "src/workers/webp-worker.ts")],
  bundle: true,
  // A classic worker: module workers are newer than some Safari still in use.
  format: "iife",
  target: "safari15",
  minify: true,
  // The encoder asks for its own address to find its WebAssembly: the
  // worker's, which the file sits beside.
  define: { "import.meta.url": "self.location.href" },
  outfile: join(out, "webp-worker.js"),
  logLevel: "warning",
});
// Without SIMD: slower, but every browser that runs WebAssembly runs it.
await copyFile(join(encoder, "codec/enc/webp_enc.wasm"), join(out, "webp_enc.wasm"));

const size = async (file) => (await stat(join(out, file))).size;
const kb = ((await size("webp-worker.js")) + (await size("webp_enc.wasm"))) / 1024;
console.log(`webp: エンコーダーを public/webp/${version} へ配置 (${kb.toFixed(0)} KB)`);
