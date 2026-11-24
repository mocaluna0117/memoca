// How long 「PDF で書き出す」 takes for a long note with pictures, per engine:
// from the menu item to the file. The note (`--paras` paragraphs, `--images`
// pictures between them) is made in Chromium, which can paste pictures as
// files, then exported in the engine asked for (webkit: as the Mac app),
// signed in to the same account. `--size=1600x1000` is each picture's size;
// `--keep=dir` keeps the PDFs, to look at. `--burn=1` keeps 8 cores busy
// while exporting; `--list` prints where the note's pictures are.
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/pdf-export.mjs --engine=webkit --paras=240 --images=16 [--runs=2] [--keep=dir]
import { chromium, webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, editor, openApp, pasteData, pastePicture, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const ENGINE = args.engine ?? "webkit";
const PARAS = Number(args.paras ?? 120);
const IMAGES = Number(args.images ?? 10);
const RUNS = Number(args.runs ?? 1);
/** Each picture's size, as --size=1600x1000. */
const SIZE = (args.size ?? "1600x1000").split("x").map(Number);

// The note is made in Chromium (pictures pasted as files), then exported in
// the engine asked for, signed in to the same account.
const maker = await chromium.launch();
const makerContext = await maker.newContext({ viewport: { width: 1280, height: 900 } });
let page = await makerContext.newPage();
const email = await signUp(page);
await openApp(page);
await page.getByRole("button", { name: "新しいメモ" }).first().click();
await page.getByLabel("メモのタイトル").waitFor();
await page.getByLabel("メモのタイトル").fill("長いメモ");
await editor(page).click();

// Text and pictures, interleaved: a paragraph block of text between pictures.
const per = Math.max(1, Math.floor(PARAS / Math.max(1, IMAGES + 1)));
const paragraph = (i) =>
  `<p>${i + 1}. 明日の打ち合わせは 10:00 から。資料は前の日までに共有し、議題は三つに絞る。終わったら議事録を書いて、みんなに送ること。</p>`;
let written = 0;
for (let image = 0; image <= IMAGES; image++) {
  const html = Array.from({ length: per }, (_, i) => paragraph(written + i)).join("");
  written += per;
  await editor(page).press("ControlOrMeta+End");
  await pasteData(page, { "text/html": html, "text/plain": "x" });
  await page.waitForTimeout(150);
  if (image < IMAGES) {
    await editor(page).press("ControlOrMeta+End");
    // At the caret, the note's end: a click would land on a picture in a short note, which the paste then replaced.
    await pastePicture(page, { width: SIZE[0], height: SIZE[1], kind: image % 2 ? "screen" : "photo", name: `p${image}.png`, click: false });
    await page.waitForTimeout(400);
  }
}
await page.waitForFunction(
  (n) => document.querySelectorAll('[data-content-type="image"] img').length >= n,
  IMAGES,
  { timeout: 240_000 },
);
await page.waitForTimeout(2000);
const noteUrl = page.url();
await page.waitForTimeout(3000);
await maker.close();

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
page = await context.newPage();
await page.goto(BASE + "/");
await page.evaluate(() => localStorage.setItem("memoca:welcome-off", "1"));
const status = await page.evaluate(async (address) => {
  const res = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: address, password: "memoca-e2e-password" }),
  });
  return res.status;
}, email);
if (status >= 400) throw new Error(`sign-in failed: ${status}`);
await page.goto(noteUrl);
await page.getByLabel("メモのタイトル").waitFor({ timeout: 60_000 });
await page.waitForFunction(
  (n) => [...document.querySelectorAll('[data-content-type="image"] img')].filter((i) => i.complete && i.naturalWidth > 0).length >= n,
  IMAGES,
  { timeout: 120_000 },
);
await page.waitForTimeout(2000);
const blocks = await page.locator(".bn-block-outer").count();
if (args.list) {
  // Each picture of the note as the engine has it: where, and whether drawn.
  console.log(
    JSON.stringify(
      await editor(page).evaluate((root) => {
        const top = root.getBoundingClientRect().top;
        return [...root.querySelectorAll('[data-content-type="image"] img')].map((img) => [
          Math.round(img.getBoundingClientRect().top - top),
          Math.round(img.getBoundingClientRect().height),
          img.complete,
          img.naturalWidth,
        ]);
      }),
    ),
  );
}
const height = await editor(page).evaluate((el) => Math.round(el.getBoundingClientRect().height));
console.log(`engine=${ENGINE} blocks=${blocks} images=${IMAGES} editorHeight=${height}px`);

// --burn=1: eight cores kept busy while exporting (2: sixteen; not while the note is
// made), as a Mac busy with other apps, where pictures came late.
const burners = Array.from({ length: Number(args.burn ?? 0) * 8 }, () =>
  spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
);
const times = [];
for (let run = 0; run < RUNS; run++) {
  const download = page.waitForEvent("download", { timeout: 1_800_000 });
  const started = Date.now();
  await page.getByRole("button", { name: "メモの操作" }).click();
  await page.getByRole("menuitem", { name: "PDF で書き出す" }).click();
  const file = await download;
  const ms = Date.now() - started;
  times.push(ms);
  console.log(`run ${run + 1}: ${(ms / 1000).toFixed(1)} s`);
  if (args.keep) {
    mkdirSync(args.keep, { recursive: true });
    await file.saveAs(join(args.keep, `${ENGINE}-${PARAS}p-${IMAGES}img-${args.size ?? "1600x1000"}-${run}.pdf`));
  }
  await page.waitForTimeout(1000);
}
for (const burner of burners) burner.kill();
writeFileSync(
  join(process.env.UX_OUT ?? import.meta.dirname, `pdf-export-${ENGINE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  JSON.stringify({ engine: ENGINE, blocks, images: IMAGES, height, times }, null, 2),
);
await browser.close();
