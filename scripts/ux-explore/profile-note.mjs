// Where a note's time goes as it is typed into: CPU profiles of typing 200
// characters (by inserted text) and of Japanese typed through an input
// method's composition, into a short note and into one of 300 lines, with
// the CPU 4× slower. Self time summed by function and by chunk, and what
// ran inside any long task.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/profile-note.mjs --device=pixel7|desktop [--only=short,long]
import { writeFileSync } from "node:fs";
import { chromium, devices } from "@playwright/test";
import {
  PERF_INIT,
  RENDERS_INIT,
  createNote,
  editor,
  longTasksSince,
  openApp,
  pasteData,
  perfCollect,
  perfReset,
  printProfile,
  seedNotes,
  signUp,
  startProfile,
  stopProfile,
} from "./lib.mjs";

const arg = (name, fallback) => process.argv.find((each) => each.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const device = arg("device", "pixel7");
const only = arg("only", "short,long").split(",");
/** Where to keep each profile, as JSON, to be looked into further (scripts/ux-explore/inclusive.mjs). */
const save = arg("save", null);
const keep = (name, profiled) => {
  if (save) writeFileSync(`${save}/${device}-${name.replace(/[^a-z0-9]+/gi, "-")}.json`, JSON.stringify(profiled));
};
const descriptor = device === "desktop" ? { viewport: { width: 1280, height: 800 } } : devices["Pixel 7"];

const browser = await chromium.launch();
const context = await browser.newContext({ ...descriptor, locale: "ja-JP" });
await context.addInitScript(PERF_INIT);
const renders = process.argv.includes("--renders");
if (renders) await context.addInitScript(RENDERS_INIT);
const page = await context.newPage();
await signUp(page);
await openApp(page);
const seeded = Number(arg("notes", 0));
if (seeded > 0) await seedNotes(page, seeded);
const cdp = await context.newCDPSession(page);

const TEXT = "入力の遅延を測ります。日本語の文章を二百文字ほど打ちます。".repeat(8).slice(0, 200);
const WORDS = [
  [["き", "きょ", "きょう", "きょうは"], "今日は"],
  [["あ", "あめ", "あめが"], "雨が"],
  [["ふ", "ふっ", "ふって", "ふってい", "ふっていま", "ふっています"], "降っています"],
];

async function typing(name) {
  await page.waitForTimeout(1500);
  await perfReset(page);
  if (renders) await page.evaluate(() => window.__uxRenders.start());
  const started = await startProfile(cdp, page);
  await page.keyboard.type(TEXT, { delay: 30 });
  await page.waitForTimeout(800);
  const profiled = await stopProfile(cdp, started);
  if (renders) {
    const counted = await page.evaluate(() => window.__uxRenders.stop());
    const started = await page.evaluate(() => window.__uxRenders.starts());
    console.log(`\n=== ${name}: where renders start (component#hook × times)`);
    console.log(started.slice(0, 40).map(([where, times]) => `${where}×${times}`).join("  "));
    console.log(`\n=== ${name}: renders while typing 200 chars (component × times)`);
    console.log(counted.slice(0, 400).map(([component, times]) => `${component}×${times}`).join("  "));
  }
  const perf = await perfCollect(page);
  keep(`${name}-typing`, profiled);
  printProfile(`${name}: typing 200 chars`, profiled, JSON.stringify(perf), await longTasksSince(page, started.mark));
}

async function composing(name) {
  await page.waitForTimeout(1000);
  await perfReset(page);
  const started = await startProfile(cdp, page);
  for (let round = 0; round < 6; round += 1) {
    for (const [steps, word] of WORDS) {
      for (const step of steps) {
        await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
        await page.waitForTimeout(40);
      }
      await cdp.send("Input.insertText", { text: word });
      await page.waitForTimeout(40);
    }
  }
  await page.waitForTimeout(800);
  const profiled = await stopProfile(cdp, started);
  const perf = await perfCollect(page);
  keep(`${name}-composing`, profiled);
  printProfile(`${name}: composing 6×3 words`, profiled, JSON.stringify(perf), await longTasksSince(page, started.mark));
}

if (only.includes("short")) {
  await createNote(page, "短いメモ");
  await editor(page).click();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await typing("short");
  await composing("short");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
}

if (only.includes("long")) {
  await createNote(page, "長いメモ");
  await editor(page).click();
  const html = Array.from({ length: 300 }, (_, i) => `<p>${i + 1} 行目のテキストです。少し長めの文章で、折り返しが起きる程度の長さにしておきます。</p>`).join("");
  await pasteData(page, { "text/html": html });
  await page.waitForTimeout(2500);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("End");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await typing("long");
  await composing("long");
}

await browser.close();
