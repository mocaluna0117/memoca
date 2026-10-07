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
 *   adapted to undo them with the browser's own decoder (DecompressionStream),
 *   or, in a browser with none for Brotli, with one in JavaScript bundled with
 *   it. The browser's where it has one: in WKWebView (Memoca for Mac) the one
 *   in JavaScript took a few seconds, the browser's own well under one.
 *
 * Named .dat.gz, as kuromoji names them, though Brotli is what they hold: for
 * the type they are served with, application/gzip, which a CDN sends as it is.
 * As application/octet-stream (named .brotli), Vercel compressed them again,
 * for nothing. Nor may they be named .br, which a server may take for the
 * compressed form of another and send undone.
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
import { createHash } from "node:crypto";

/** Changed with anything that changes the files built; src/lib/search/yomi.ts reads it too. */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version: VERSION } = JSON.parse(await readFile(join(root, "src/lib/search/yomi-asset.json"), "utf8"));
const workerSource = join(root, "src/workers/yomi-worker.js");
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
// This script's own text too, and the worker's: what it builds changes with them.
const scriptHash = createHash("sha256")
  .update(await readFile(fileURLToPath(import.meta.url)))
  .update(await readFile(workerSource))
  .digest("hex")
  .slice(0, 12);
const stamp = `${VERSION}-${kuromojiVersion}-${scriptHash}`;
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
  await writeFile(join(to, `${name}.dat.gz`), brotli(bytes));
}

// The worker, in one file with what it runs: the Brotli decoder, and
// kuromoji, its loader undoing the files it asks for with that decoder. One
// file, loading no other: see src/workers/yomi-worker.js.
const decoder = await build({
  stdin: {
    contents: `import decompress from "brotli/decompress.js";
      /** Whether the browser undoes Brotli itself. */
      const native = (() => {
        try {
          new DecompressionStream("brotli");
          return true;
        } catch {
          return false;
        }
      })();
      // Bytes of a buffer of their own, exactly as long as they are: the
      // loader hands on their .buffer.
      self.memocaBrotliDecode = async (bytes) => {
        if (native) {
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("brotli"));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        return decompress(bytes).slice();
      };`,
    resolveDir: root,
  },
  bundle: true,
  format: "iife",
  target: "safari15",
  minify: true,
  write: false,
  logLevel: "warning",
});
let script = await readFile(join(kuromoji, "build/kuromoji.js"), "utf8");
const adapt = (from, into, times) => {
  const found = script.split(from).length - 1;
  if (found !== times) {
    console.error(`kuromoji.js: 「${from}」が ${times} か所ではなく ${found} か所あります。辞書の読み込みを直せません。`);
    process.exit(1);
  }
  script = script.split(from).join(into);
};
adapt(
  `            var gz = fflate.gunzipSync(new Uint8Array(arraybuffer));
            callback(null, gz.buffer);`,
  `            self.memocaBrotliDecode(new Uint8Array(arraybuffer)).then(function (gz) {
                callback(null, gz.buffer);
            }, function (error) {
                callback(error, null);
            });`,
  1,
);
await writeFile(
  join(to, "yomi-worker.js"),
  [decoder.outputFiles[0].text, script, await readFile(workerSource, "utf8")].join(";\n"),
);

await writeFile(stampFile, stamp);
await rm(cached, { recursive: true, force: true });
await cp(to, cached, { recursive: true });

let bytes = 0;
const built = await readdir(to);
for (const file of built) bytes += (await stat(join(to, file))).size;
console.log(
  `kuromoji: ${built.length - 1} ファイル (${(bytes / 1048576).toFixed(1)} MB) を public/kuromoji/${VERSION} へ配置`,
);
