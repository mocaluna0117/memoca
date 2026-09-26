/**
 * The fingerprint of what the WebP worker is built from: its source, its build
 * script, and the encoder's version. Recorded in src/lib/media/webp-asset.json
 * with the version; tests/webp-encoder.test.ts fails when they no longer
 * match, because the worker's files are cached as immutable under a path with
 * the version in it, and a changed worker needs a new one.
 *
 *   node scripts/webp-source-hash.mjs   prints it, to record with a new version
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function webpSourceHash(root) {
  const hash = createHash("sha256");
  for (const file of ["src/workers/webp-worker.ts", "scripts/build-webp-worker.mjs"]) {
    hash.update(readFileSync(join(root, file)));
  }
  hash.update(JSON.parse(readFileSync(join(root, "node_modules/@jsquash/webp/package.json"), "utf8")).version);
  return hash.digest("hex").slice(0, 16);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(webpSourceHash(join(dirname(fileURLToPath(import.meta.url)), "..")));
}
