import { type Page, expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { pasteImage, uploadsDrained } from "./image-helpers";

/**
 * Records every percent the export's cover shows on its bar, from when it is
 * put up to when it is taken away.
 */
async function watchProgress(page: Page) {
  await page.evaluate(() => {
    const seen: number[] = [];
    // Each change's value as it was before it, and the last as it is: a
    // change soon followed by another in the same task is kept too.
    let last: Element | null = null;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue !== null) seen.push(Number(record.oldValue));
        last = record.target as Element;
      }
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-valuenow"],
      attributeOldValue: true,
    });
    (window as unknown as { pdfProgress: () => number[] }).pdfProgress = () =>
      last ? [...seen, Number(last.getAttribute("aria-valuenow"))] : seen;
  });
  return () => page.evaluate(() => (window as unknown as { pdfProgress: () => number[] }).pdfProgress());
}

/** A note of `lines` lines under a heading, more than a sheet long. */
async function longNote(page: Page, title: string, lines: number) {
  await createNote(page, title);
  await editor(page).click();
  await page.keyboard.type("# 見出し");
  await page.keyboard.press("Enter");
  for (let line = 1; line <= lines; line += 1) {
    await page.keyboard.type(`${line} 行目`);
    await page.keyboard.press("Enter");
  }
}

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
  await longNote(page, "書き出すメモ", 50);
  await pasteImage(page, { name: "絵.png" });
  await uploadsDrained(page);
  await waitForSynced(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  const width = await editor(page).evaluate((element) => element.closest(".memoca-editor")!.clientWidth);

  const progress = await watchProgress(page);
  const saving = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "PDF で書き出す" }).click();
  // How far it has come, as it is made.
  await expect(page.getByRole("progressbar", { name: "PDF の書き出し" })).toBeVisible();
  await expect(page.locator(".memoca-export-cover")).toContainText(/PDF を書き出しています… \d+%/);
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

  // Counted up from 0 as it was made, never back, with 100 only as the file was done.
  const percents = await progress();
  expect(percents[0]).toBe(0);
  expect(percents.at(-1)).toBe(100);
  expect(percents.filter((percent) => percent === 100)).toHaveLength(1);
  expect(percents).toEqual([...percents].sort((a, b) => a - b));
  expect(new Set(percents.filter((percent) => percent > 0 && percent < 100)).size).toBeGreaterThanOrEqual(3);

  // And the app is as it was: dark, its note at its own width, nothing over it.
  await expect(page.locator(".memoca-export-cover")).toHaveCount(0);
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await editor(page).evaluate((element) => element.closest(".memoca-editor")!.clientWidth)).toBe(width);
});

test("a PDF being made can be cancelled from its cover: nothing is saved, the app is as it was, and it can be made again", async ({
  page,
}) => {
  test.slow();
  await page.emulateMedia({ colorScheme: "dark" });
  await signUp(page);
  await openApp(page);
  await longNote(page, "やめるメモ", 100);
  await waitForSynced(page);
  const width = await editor(page).evaluate((element) => element.closest(".memoca-editor")!.clientWidth);

  let downloads = 0;
  page.on("download", () => (downloads += 1));
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "PDF で書き出す" }).click();
  const cancel = page.locator(".memoca-export-cover").getByRole("button", { name: "キャンセル" });
  await expect(cancel).toBeVisible();
  // Given the focus, for the keyboard.
  await expect(cancel).toBeFocused();
  await cancel.click();

  await expect(page.locator(".memoca-export-cover")).toHaveCount(0);
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await editor(page).evaluate((element) => element.closest(".memoca-editor")!.clientWidth)).toBe(width);
  // Not a failure: nothing said.
  await page.waitForTimeout(1_000);
  await expect(page.getByText("PDF を作れませんでした")).toHaveCount(0);
  expect(downloads).toBe(0);

  // And made again, to the end.
  const saving = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "PDF で書き出す" }).click();
  expect((await saving).suggestedFilename()).toBe("やめるメモ.pdf");
  await expect(page.locator(".memoca-export-cover")).toHaveCount(0);
});

test("a note's links are links in its PDF: pressed, they open where they go", async ({ page }, testInfo) => {
  await signUp(page);
  await openApp(page);
  await createNote(page, "リンクのあるメモ");
  await editor(page).click();
  // Made a link as it is typed, with the space after it.
  await page.keyboard.type("募集ページ https://example.com/winter ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("次の行");
  await expect(editor(page).locator('a[href="https://example.com/winter"]')).toBeVisible();
  await waitForSynced(page);

  const saving = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "PDF で書き出す" }).click();
  const saved = await saving;
  const path = testInfo.outputPath("links.pdf");
  await saved.saveAs(path);
  const text = (await readFile(path)).toString("latin1");
  const link = /\/Subtype \/Link \/Rect \[([\d. ]+)\] .*?\/URI \(([^)]*)\)/.exec(text);
  expect(link?.[2]).toBe("https://example.com/winter");
  // On the sheet, near its top, where the first line is: right of the
  // margin, under the title, and as wide as a few words.
  const [x1, y1, x2, y2] = link![1]!.split(" ").map(Number) as [number, number, number, number];
  expect(x1).toBeGreaterThan(40);
  expect(x2 - x1).toBeGreaterThan(40);
  expect(y2).toBeGreaterThan(842 - 200);
  expect(y2).toBeLessThan(842 - 40);
  expect(y2 - y1).toBeGreaterThan(5);
});
