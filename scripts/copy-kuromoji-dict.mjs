/**
 * Builds kuromoji's dictionary into public/kuromoji/<version>/ so the app can
 * serve it from its own origin, made smaller than kuromoji ships it.
 *
 * Kept out of the repository: it is a build artefact of a dependency. Served
 * ourselves, the service worker can cache it and reading search keeps working
 * offline.
 *
 * Smaller in two ways, neither changing a reading found:
 *
 * - Each word's features are cut to what reading search reads: its surface
 *   and its reading. Kuromoji keeps a word's part of speech, its conjugation,
 *   its base form and its pronunciation too, which nothing here uses, and is
 *   by far the largest file. The words, their costs and the trie that splits
 *   text into them are as they were, so text is split exactly as before.
 * - Brotli rather than gzip: about a third smaller again. Kuromoji's loader is
 *   adapted to ask for these files and to undo them with a Brotli decoder
 *   (JavaScript, no WebAssembly) loaded beside it. Named .brotli, not .br: a
 *   server or a CDN may take a .br file for the compressed form of another
 *   and send it decompressed, which the decoder could not then undo.
 *
 * The version in the path changes whenever what is built does, so a device
 * never mixes files of two builds from its cache (src/app/sw.ts drops those of
 * another version). public/yomi-worker.js names the same version.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gunzipSync } from "node:zlib";

/** Changed with anything that changes the files built; public/yomi-worker.js names it too. */
const VERSION = "2";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kuromoji = join(root, "node_modules/@sglkc/kuromoji");
const from = join(kuromoji, "dict");
const base = join(root, "public/kuromoji");
const to = join(base, VERSION);

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

// Brotli at its best takes a couple of minutes: built once for each kuromoji
// and version, and kept in Next's build cache, which Vercel keeps between
// deployments, to be copied from there.
const { version: kuromojiVersion } = JSON.parse(await readFile(join(kuromoji, "package.json"), "utf8"));
const stamp = `${VERSION}-${kuromojiVersion}`;
const stampFile = join(to, ".built");
const cached = join(root, ".next/cache/memoca-kuromoji", stamp);
if ((await exists(stampFile)) && (await readFile(stampFile, "utf8")) === stamp) {
  console.log(`kuromoji: public/kuromoji/${VERSION} は作成済み`);
  process.exit(0);
}
// Nothing of another version left to be served.
await rm(base, { recursive: true, force: true });
if (await exists(join(cached, ".built"))) {
  await cp(cached, to, { recursive: true });
  console.log(`kuromoji: public/kuromoji/${VERSION} をビルドキャッシュから配置`);
  process.exit(0);
}
await mkdir(to, { recursive: true });

const brotli = (bytes) =>
  brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
const raw = async (name) => Buffer.from(gunzipSync(await readFile(join(from, `${name}.dat.gz`))));

/**
 * The words' entries (tid.dat) and their features (tid_pos.dat), the features
 * cut to the surface and the reading. An entry is ten bytes, little-endian:
 * its left and right context ids and its cost (16 bits each), and where its
 * features start (32 bits). The features are NUL-ended UTF-8, comma-separated,
 * the surface first: IpadicFormatter reads the reading at index 8, so it stays
 * there, the fields before it empty. One with no reading of its own, or the
 * same as its surface, keeps the surface alone (the worker uses the surface
 * then). Features alike are kept once.
 */
function slimWords(tid, pos) {
  const feature = (at) => {
    let end = at;
    while (end < pos.length && pos[end] !== 0) end += 1;
    return pos.subarray(at, end).toString("utf8");
  };
  // Kuromoji's buffers are grown in powers of two: what follows the last entry is zeros.
  let count = 0;
  while ((count + 1) * 10 <= tid.length && (count === 0 || tid.readUInt32LE(count * 10) !== 0 || tid.readUInt32LE(count * 10 + 4) !== 0 || tid.readUInt16LE(count * 10 + 8) !== 0)) {
    count += 1;
  }
  const entries = Buffer.from(tid.subarray(0, count * 10));
  const kept = new Map();
  const chunks = [];
  let size = 0;
  for (let index = 0; index < count; index += 1) {
    const fields = feature(entries.readInt32LE(index * 10 + 6)).split(",");
    const [surface] = fields;
    const reading = fields[8] && fields[8] !== "*" ? fields[8] : "";
    const slim = reading && reading !== surface ? `${surface},,,,,,,,${reading}` : surface;
    let at = kept.get(slim);
    if (at === undefined) {
      at = size;
      kept.set(slim, at);
      const bytes = Buffer.from(`${slim}\0`, "utf8");
      chunks.push(bytes);
      size += bytes.length;
    }
    entries.writeInt32LE(at, index * 10 + 6);
  }
  return { tid: entries, pos: Buffer.concat(chunks) };
}

const words = slimWords(await raw("tid"), await raw("tid_pos"));
const files = {
  tid: words.tid,
  tid_pos: words.pos,
  ...Object.fromEntries(
    await Promise.all(
      ["base", "check", "cc", "tid_map", "unk", "unk_pos", "unk_map", "unk_char", "unk_compat", "unk_invoke"].map(
        async (name) => [name, await raw(name)],
      ),
    ),
  ),
};
for (const [name, bytes] of Object.entries(files)) {
  await writeFile(join(to, `${name}.dat.brotli`), brotli(bytes));
}

// The Brotli decoder, as a plain script for the worker to load beside kuromoji.
await build({
  stdin: {
    contents: `import decompress from "brotli/decompress.js";
      // A buffer of its own, exactly as long as what it holds: the loader hands on its .buffer.
      self.memocaBrotliDecode = (bytes) => decompress(bytes).slice();`,
    resolveDir: root,
  },
  bundle: true,
  format: "iife",
  target: "safari15",
  minify: true,
  outfile: join(to, "brotli.js"),
  logLevel: "warning",
});

// Kuromoji itself, its loader asking for the .brotli files and undoing them with
// that decoder. The worker in public/ loads it with importScripts, deliberately
// outside the bundler: Turbopack's `new Worker(new URL(...))` transform did not
// produce a usable worker here, and a plain classic worker has no build step to
// go wrong.
let script = await readFile(join(kuromoji, "build/kuromoji.js"), "utf8");
const adapt = (from, into, times) => {
  const found = script.split(from).length - 1;
  if (found !== times) {
    console.error(`kuromoji.js: 「${from}」が ${times} か所ではなく ${found} か所あります。辞書の読み込みを直せません。`);
    process.exit(1);
  }
  script = script.split(from).join(into);
};
adapt("fflate.gunzipSync(new Uint8Array(arraybuffer))", "self.memocaBrotliDecode(new Uint8Array(arraybuffer))", 1);
adapt('.dat.gz"', '.dat.brotli"', 12);
await writeFile(join(to, "kuromoji.js"), script);

await writeFile(stampFile, stamp);
await rm(cached, { recursive: true, force: true });
await cp(to, cached, { recursive: true });

let bytes = 0;
const built = await readdir(to);
for (const file of built) bytes += (await stat(join(to, file))).size;
console.log(
  `kuromoji: ${built.length - 1} ファイル (${(bytes / 1048576).toFixed(1)} MB) を public/kuromoji/${VERSION} へ配置`,
);
