import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { pasteImage } from "./image-helpers";

/** The names in an archive, and a file's text, read as Finder or Windows read them. */
function readZip(file: string, wanted: string): { names: string[]; text: string } {
  const script = `import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
name = next(n for n in z.namelist() if n.endswith(sys.argv[2]))
print(json.dumps({"names": z.namelist(), "text": z.read(name).decode()}))`;
  return JSON.parse(execFileSync("python3", ["-c", script, file, wanted], { encoding: "utf8" }));
}

test("every note is saved as one ZIP of Markdown, with the images it shows", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "saved as a download on a computer");
  await signUp(page);
  await openApp(page);
  await createNote(page, "書き出すメモ");
  await editor(page).click();
  await page.keyboard.type("- 一つ目");
  await page.keyboard.press("Enter");
  await page.keyboard.type("二つ目");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await pasteImage(page, { name: "図.png" });
  await waitForSynced(page);

  await page.goto("/app/settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "すべてのメモを書き出す" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^Memoca-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByText(/メモ \d+ 件とファイル 1 件を書き出しました/)).toBeVisible();

  const file = testInfo.outputPath("export.zip");
  await download.saveAs(file);
  const { names, text } = readZip(file, "/書き出すメモ.md");
  expect(text).toContain("# 書き出すメモ");
  expect(text).toMatch(/[*-] 一つ目/);
  const image = names.find((name) => /\/ファイル\/.+-図\.(webp|png)$/.test(name));
  expect(image).toBeTruthy();
  // The note points at the image beside it.
  expect(decodeURI(text)).toContain(image!.split("/").slice(1).join("/"));
});
