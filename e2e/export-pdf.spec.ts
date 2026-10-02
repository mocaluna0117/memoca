import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { pasteImage, uploadsDrained } from "./image-helpers";

/** Each page's picture in a PDF Memoca wrote: its size and its RGB pixels (lossless ones only). */
function pictures(pdf: Buffer) {
  const found: { width: number; height: number; rgb: Buffer | null }[] = [];
  const head = /\/Width (\d+) \/Height (\d+) \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/(\w+) \/Length (\d+) >>\nstream\n/g;
  const text = pdf.toString("latin1");
  for (const match of text.matchAll(head)) {
    const start = match.index! + match[0].length;
    const data = pdf.subarray(start, start + Number(match[4]));
    found.push({
      width: Number(match[1]),
      height: Number(match[2]),
      rgb: match[3] === "FlateDecode" ? inflateSync(data) : null,
    });
  }
  return found;
}

test("a note is saved as a PDF that looks as it does, light whatever the theme, over as many sheets as it needs", async ({
  page,
}, testInfo) => {
  test.slow();
  await page.emulateMedia({ colorScheme: "dark" });
  await signUp(page);
  await openApp(page);
  await createNote(page, "書き出すメモ");
  await editor(page).click();
  await page.keyboard.type("# 見出し");
  await page.keyboard.press("Enter");
  for (let line = 1; line <= 50; line += 1) {
    await page.keyboard.type(`${line} 行目`);
    await page.keyboard.press("Enter");
  }
  await pasteImage(page, { name: "絵.png" });
  await uploadsDrained(page);
  await waitForSynced(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  const width = await editor(page).evaluate((element) => element.closest(".memoca-editor")!.clientWidth);

  const saving = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "PDF で書き出す" }).click();
  const saved = await saving;
  expect(saved.suggestedFilename()).toBe("書き出すメモ.pdf");
  const path = testInfo.outputPath("note.pdf");
  await saved.saveAs(path);
  const pdf = await readFile(path);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

  // Two sheets or more, each its picture at the width of a sheet.
  const found = pictures(pdf);
  expect(found.length).toBeGreaterThanOrEqual(2);
  for (const picture of found) expect(picture.width).toBe(2880);
  // Light: the first sheet's corner is white, not the dark theme's.
  const first = found[0]!;
  expect([...first.rgb!.subarray(0, 3)].every((channel) => channel > 240)).toBe(true);
  // The image is in it: red, as its top left quarter is.
  const red = found.some(({ rgb }) => {
    if (!rgb) return true;
    for (let at = 0; at < rgb.length; at += 3) {
      if (rgb[at]! > 240 && rgb[at + 1]! < 30 && rgb[at + 2]! < 30) return true;
    }
    return false;
  });
  expect(red).toBe(true);

  // And the app is as it was: dark, its note at its own width, nothing over it.
  await expect(page.locator(".memoca-export-cover")).toHaveCount(0);
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await editor(page).evaluate((element) => element.closest(".memoca-editor")!.clientWidth)).toBe(width);
});
