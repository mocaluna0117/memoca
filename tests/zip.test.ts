import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { crc32, zip } from "@/lib/export/zip";

describe("a ZIP archive", () => {
  test("has the CRC-32 every unzipper checks", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("is read by an unzipper as it is, Japanese names and all", async () => {
    const archive = zip([
      { path: "Memoca/仕事/議事録.md", data: new TextEncoder().encode("# 議事録\n") },
      { path: "Memoca/ファイル/図.webp", data: new Uint8Array([1, 2, 3]) },
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
      names: ["Memoca/仕事/議事録.md", "Memoca/ファイル/図.webp"],
      bad: null,
      text: "# 議事録\n",
    });
  });
});
