/**
 * Copies what pdf.js needs besides itself into public/pdfjs/<version>/: its
 * worker, the character maps Japanese PDFs often need (fonts not embedded),
 * the standard fonts, its WebAssembly decoders and colour profile.
 *
 * Copied rather than kept in the repository, like the kuromoji dictionary: it
 * comes with a dependency. The version in the path is pdf.js's own, which the
 * page reads from the library, so the two always match, and a new version
 * never meets an old file cached as immutable. Fetched only when a PDF is
 * shown, and kept then by the service worker.
 */
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules/pdfjs-dist");
const { version } = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
const to = join(root, "public/pdfjs", version);

await rm(join(root, "public/pdfjs"), { recursive: true, force: true });
await mkdir(to, { recursive: true });
// The legacy build: the other needs JavaScript newer than some Safari still in use.
await cp(join(from, "legacy/build/pdf.worker.min.mjs"), join(to, "pdf.worker.min.mjs"));
await cp(join(from, "LICENSE"), join(to, "LICENSE"));
for (const folder of ["cmaps", "standard_fonts", "iccs"]) {
  await cp(join(from, folder), join(to, folder), { recursive: true });
}
// Not the JavaScript engine for scripts in a PDF: none are run.
await cp(join(from, "wasm"), join(to, "wasm"), {
  recursive: true,
  filter: (path) => !/quickjs/.test(path),
});
console.log(`pdf.js: 付属ファイルを public/pdfjs/${version} へ配置`);
