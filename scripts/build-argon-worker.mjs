/**
 * Builds the Argon2id worker into public/argon/<version>/, as
 * scripts/build-webp-worker.mjs does the WebP one: made from a dependency
 * (hash-wasm, its WebAssembly inside its JavaScript), under a path whose
 * version (src/lib/crypto/argon-asset.json) changes with it, so a new build
 * never meets an old file cached as immutable.
 */
import { build } from "esbuild";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "src/lib/crypto/argon-asset.json"), "utf8"));
const out = join(root, "public/argon", version);

await rm(join(root, "public/argon"), { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, "src/workers/argon-worker.ts")],
  bundle: true,
  format: "iife",
  target: "safari15",
  minify: true,
  outfile: join(out, "argon-worker.js"),
  logLevel: "warning",
});
const kb = (await stat(join(out, "argon-worker.js"))).size / 1024;
console.log(`argon2: ワーカーを public/argon/${version} へ配置 (${kb.toFixed(0)} KB)`);
