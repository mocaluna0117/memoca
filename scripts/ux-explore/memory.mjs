// What the app holds on to the longer a page stays open, and how typing
// fares when memory is short. Chromium only for the heap (CDP); `--engine=
// webkit` runs the same cycles and reports what WebKit can tell (DOM nodes).
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/memory.mjs [--cycles=60] [--only=notes,quick,palette,pressure] [--engine=webkit]
//
// For each cycle set: the page's figures after a forced garbage collection
// (JS heap, DOM nodes, event listeners, documents) every 10 cycles, and the
// growth per cycle after the first 10 (warm-up). Then typing in a 300-line
// note with the CPU 4× slower: as it is, with the browser told memory is
// critically short every half second, and in a browser whose JS heap is
// held to 160 MB.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { BASE, PERF_INIT, createNote, editor, openApp, pasteData, perfCollect, perfReset, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const CYCLES = Number(args.cycles ?? 60);
const only = new Set((args.only ?? "notes,quick,palette,pressure").split(","));
const engine = args.engine === "webkit" ? webkit : chromium;
const isChromium = engine === chromium;
const results = {};

async function figures(page, cdp) {
  if (!cdp) {
    return { nodes: await page.evaluate(() => document.getElementsByTagName("*").length) };
  }
  await cdp.send("HeapProfiler.collectGarbage");
  await page.waitForTimeout(100);
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    heapMB: Math.round((get("JSHeapUsedSize") / 1048576) * 10) / 10,
    nodes: get("Nodes"),
    listeners: get("JSEventListeners"),
    documents: get("Documents"),
  };
}

/** Runs `step` `CYCLES` times, taking figures every 10, and the growth per cycle after the first 10. */
async function cycle(name, page, cdp, step) {
  const samples = [];
  for (let i = 0; i <= CYCLES; i++) {
    if (i % 10 === 0) {
      const at = await figures(page, cdp);
      samples.push({ cycle: i, ...at });
      console.log(`${name} ${i}: ${JSON.stringify(at)}`);
    }
    if (i < CYCLES) await step(i);
  }
  const warm = samples.find((s) => s.cycle === 10) ?? samples[0];
  const last = samples.at(-1);
  const span = last.cycle - warm.cycle || 1;
  const per = {};
  for (const key of Object.keys(last)) {
    if (key === "cycle") continue;
    per[key] = Math.round(((last[key] - warm[key]) / span) * 1000) / 1000;
  }
  results[name] = { samples, perCycleAfterWarmup: per };
  console.log(`${name}: per cycle after warm-up ${JSON.stringify(per)}`);
}

async function session(launchArgs = []) {
  const browser = await engine.launch({ args: launchArgs });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ja-JP" });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  const cdp = isChromium ? await context.newCDPSession(page) : null;
  if (cdp) await cdp.send("Performance.enable");
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("crash", () => errors.push("page crashed"));
  await signUp(page);
  return { browser, context, page, cdp, errors };
}

const { browser, page, cdp, errors } = await session();

if (only.has("notes")) {
  await openApp(page);
  for (let i = 0; i < 6; i++) await createNote(page, `メモ ${i + 1}`, `本文 ${i + 1} の段落です。\n- 箇条書き\n- もう一つ`);
  // A new account shows each folder's notes in the sidebar (the explorer).
  const row = (i) => page.locator("aside").getByText(`メモ ${i + 1}`, { exact: true });
  await row(5).waitFor();
  await cycle("open-notes", page, cdp, async (i) => {
    await row(i % 6).click();
    await page.waitForTimeout(250);
  });
}

if (only.has("quick")) {
  await page.goto(BASE + "/quick?window=1");
  const quickEditor = page.locator('[contenteditable="true"]').first();
  await quickEditor.waitFor({ timeout: 30_000 });
  await cycle("quick-tabs-todo-bell", page, cdp, async (i) => {
    await page.getByRole("button", { name: "Todo を開く" }).click();
    await page.getByLabel("Todo", { exact: true }).waitFor();
    await page.getByRole("button", { name: "期日の通知" }).click();
    await page.getByRole("dialog", { name: "期日の通知" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("tab").first().click();
    await quickEditor.click();
    await page.keyboard.type(`あ${i}`);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);
  });
}

if (only.has("palette")) {
  await openApp(page);
  await cycle("command-palette", page, cdp, async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog").first().waitFor();
    await page.keyboard.type("メモ");
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  });
}

results.errors = [...errors];
await browser.close();

/** 200 characters typed at the end of a 300-line note, the CPU 4× slower; `pressure` tells the browser memory is critically short throughout. */
async function typing(label, launchArgs, pressure) {
  const s = await session(launchArgs);
  try {
    await openApp(s.page);
    await createNote(s.page, "長いメモ");
    await editor(s.page).click();
    const html = Array.from({ length: 300 }, (_, i) => `<p>${i + 1} 行目のテキストです。少し長めの文章で、折り返しが起きる程度の長さにしておきます。</p>`).join("");
    await pasteData(s.page, { "text/html": html });
    await s.page.waitForTimeout(2000);
    await s.page.keyboard.press("Control+End");
    await s.page.keyboard.press("End");
    await s.cdp?.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await s.page.waitForTimeout(1500);
    await perfReset(s.page);
    const timer = pressure && s.cdp
      ? setInterval(() => void s.cdp.send("Memory.simulatePressureNotification", { level: "critical" }).catch(() => {}), 500)
      : null;
    const text = "入力の遅延を測ります。日本語の文章を二百文字ほど打ちます。".repeat(8).slice(0, 200);
    await s.page.keyboard.type(text, { delay: 30 });
    if (timer) clearInterval(timer);
    await s.page.waitForTimeout(1500);
    const perf = await perfCollect(s.page);
    const after = await figures(s.page, s.cdp);
    results[`typing-${label}`] = { ...perf, ...after, errors: s.errors };
    console.log(`typing ${label}: ${JSON.stringify(results[`typing-${label}`])}`);
  } catch (error) {
    results[`typing-${label}`] = { failed: String(error), errors: s.errors };
    console.log(`typing ${label}: failed ${error}`);
  } finally {
    await s.browser.close();
  }
}

if (only.has("pressure") && isChromium) {
  await typing("normal", [], false);
  await typing("critical-pressure", [], true);
  await typing("heap-160mb", ["--js-flags=--max-old-space-size=160"], true);
}

const out = join(import.meta.dirname, `memory-${args.engine ?? "chromium"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`wrote ${out}`);
