import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { crc32, zip } from "@/lib/export/zip";

const big = new Uint8Array(9 * 1024 * 1024).map((_, i) => (i * 7) & 0xff);

describe("a ZIP archive", () => {
  test("has the CRC-32 every unzipper checks", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("a Blob's CRC, read a piece at a time, is the whole's", async () => {
    const archive = new Uint8Array(await (await zip([{ path: "a", data: new Blob([big]) }])).arrayBuffer());
    const stored = new DataView(archive.buffer).getUint32(14, true);
    expect(stored).toBe(crc32(big));
  });

  test("is read by an unzipper as it is, Japanese names and all", async () => {
    const archive = await zip([
      { path: "Memoca/仕事/議事録.md", data: new TextEncoder().encode("# 議事録\n") },
      { path: "Memoca/ファイル/図.webp", data: new Uint8Array([1, 2, 3]) },
      // A file kept as a Blob, longer than a piece read at a time for its CRC.
      { path: "Memoca/ファイル/動画.mp4", data: new Blob([big]) },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "memoca-zip-"));
    const file = join(dir, "a.zip");
    writeFileSync(file, new Uint8Array(await archive.arrayBuffer()));
    // Python's zipfile, as Finder's and Windows' own: names by flag bit 11, every entry checked.
    const read = `import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"names": z.namelist(), "bad": z.testzip(), "text": z.read("Memoca/仕事/議事録.md").decode()}))`;
    let out: string;
    try {
      out = execFileSync("python3", ["-c", read, file], { encoding: "utf8" });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return; // No Python here.
      throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(JSON.parse(out)).toEqual({
      names: ["Memoca/仕事/議事録.md", "Memoca/ファイル/図.webp", "Memoca/ファイル/動画.mp4"],
      bad: null,
      text: "# 議事録\n",
    });
  });
});
