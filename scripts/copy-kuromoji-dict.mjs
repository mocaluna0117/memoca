/**
 * Copies kuromoji's dictionary into public/ so the app can serve it from its
 * own origin.
 *
 * The dictionary is 18 MB, which does not belong in the repository: it is a
 * build artefact of a dependency. Running this before `next build` keeps the
 * clone small while still serving the files ourselves, so the service worker
 * can cache them and reading search keeps working offline.
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules/@sglkc/kuromoji/dict");
const to = join(root, "public/kuromoji");

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(from))) {
  console.error("kuromoji の辞書が見つかりません。pnpm install を実行してください。");
  process.exit(1);
}

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

// The worker in public/ loads this with importScripts, deliberately outside the
// bundler: Turbopack's `new Worker(new URL(...))` transform did not produce a
// usable worker here, and a plain classic worker has no build step to go wrong.
await cp(
  join(root, "node_modules/@sglkc/kuromoji/build/kuromoji.js"),
  join(to, "kuromoji.js"),
);

const files = await readdir(to);
let bytes = 0;
for (const file of files) bytes += (await stat(join(to, file))).size;
console.log(
  `kuromoji: ${files.length} ファイル (${(bytes / 1048576).toFixed(1)} MB) を public/kuromoji へ配置`,
);
