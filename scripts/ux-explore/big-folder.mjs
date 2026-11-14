// How the note list and the sidebar's tree cope with one folder of many
// notes: whether drawing only the rows in sight (virtualising) is worth it.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/big-folder.mjs [--counts=0,500,2000,5000] [--modes=explorer,list] [--runs=3]
//
// For each count, a new account with that many notes in Inbox (on this
// device only, see seedNotes), the CPU four times slower. Medians of the runs:
// - load: the page loaded until every row of すべてのメモ is drawn
// - scroll: the list scrolled from top to bottom by the wheel; frames longer than 50 ms, long tasks
// - typing: 60 characters typed into a note with the list beside it; latency per character
// - memory: JS heap and DOM nodes once the list is drawn
// - tree (desktop): the sidebar as a tree, Inbox opened until its notes are drawn
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { BASE, PERF_INIT, editor, perfCollect, perfReset, seedNotes, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const COUNTS = (args.counts ?? "0,500,2000,5000").split(",").map(Number);
const RUNS = Number(args.runs ?? 3);
const median = (values) => {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : null;
};

const FRAMES_INIT = `
(() => {
  const ux = (window.__frames = { on: false, gaps: [] });
  let last = 0;
  const tick = (at) => {
    if (ux.on && last) ux.gaps.push(at - last);
    last = at;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function rowsDrawn(page, selector, count) {
  // From the navigation's start (or `since`), until that many rows are in the page.
  return page.evaluate(
    ({ selector, count }) =>
      new Promise((resolve) => {
        const until = performance.now() + 60_000;
        const look = () => {
          const found = document.querySelectorAll(selector).length;
          if (found >= count) resolve(performance.now());
          else if (performance.now() > until) resolve({ timedOut: true, found });
          else requestAnimationFrame(look);
        };
        look();
      }),
    { selector, count },
  );
}

async function metrics(cdp) {
  // What earlier pages left, let go of first: counted, it grew with each run.
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { heapMB: Math.round(get("JSHeapUsedSize") / 1048576), nodes: get("Nodes") };
}

/** The scrolling box a row is in. */
const scrollerOf = (page, selector) =>
  page.evaluateHandle((selector) => {
    let at = document.querySelector(selector)?.parentElement ?? null;
    while (at && !(at.scrollHeight > at.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(at).overflowY))) {
      at = at.parentElement;
    }
    return at;
  }, selector);

async function measureCount(browser, count, mode) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE });
  const page = await context.newPage();
  await page.addInitScript(PERF_INIT);
  await page.addInitScript(FRAMES_INIT);
  await page.addInitScript((mode) => localStorage.setItem("memoca:sidebar-mode", mode), mode);
  await signUp(page);
  await page.goto(`${BASE}/app`);
  await page.getByRole("heading", { name: "すべてのメモ" }).first().waitFor({ timeout: 30_000 });
  if (count > 0) await seedNotes(page, count);
  const total = count + 1; // the model note too
  const row = mode === "list" ? "[data-note-row]" : "[data-tree-note]";
  // Inbox, its notes shown, the first note open.
  const inboxHref = await page.evaluate(() => location.search);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const runs = { load: [], loadLongMs: [], open: [], openLongMs: [], scrollLongFrames: [], scrollP95: [], scrollLongMs: [], typeP50: [], typeP95: [], typeLongMs: [], heapMB: [], nodes: [] };
  for (let run = 0; run < RUNS; run += 1) {
    // Loaded at Inbox: every row of it drawn.
    await page.goto(`${BASE}/app${inboxHref}`);
    const allAt = await rowsDrawn(page, row, total);
    console.error("  load", JSON.stringify(allAt));
    if (typeof allAt !== "number") throw new Error(`rows: ${JSON.stringify(allAt)} of ${total}`);
    runs.load.push(allAt);
    runs.loadLongMs.push((await perfCollect(page)).longtaskTotalMs);
    await page.waitForTimeout(1500);
    const m = await metrics(cdp);
    runs.heapMB.push(m.heapMB);
    runs.nodes.push(m.nodes);
    if (args.only === "memory") continue;

    // Away and back to Inbox by its row in the sidebar: in the list, the
    // pinned notes between; in the tree, Inbox closed by its row first.
    if (mode === "list") await page.getByRole("button", { name: "ピン留め" }).first().click();
    else await page.locator("[data-folder-row]").first().click();
    await page.waitForFunction((row) => document.querySelectorAll(row).length < 2, row, { timeout: 30_000 });
    await page.waitForTimeout(800);
    await perfReset(page);
    const before = await page.evaluate(() => performance.now());
    await page.locator("[data-folder-row]").first().click();
    const openedAt = await rowsDrawn(page, row, total);
    console.error("  open", JSON.stringify(openedAt));
    runs.open.push(typeof openedAt === "number" ? openedAt - before : null);
    runs.openLongMs.push((await perfCollect(page)).longtaskTotalMs);
    await page.waitForTimeout(800);

    // Its rows scrolled through, top to bottom, by the wheel.
    const scroller = await scrollerOf(page, row);
    const height = await scroller.evaluate((el) => (el ? el.scrollHeight : 0));
    await page.locator(row).first().hover();
    await perfReset(page);
    await page.evaluate(() => {
      window.__frames.gaps = [];
      window.__frames.on = true;
    });
    for (let at = 0; at < height; at += 700) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
    const gaps = await page.evaluate(() => {
      window.__frames.on = false;
      return window.__frames.gaps;
    });
    const scrolled = await perfCollect(page);
    const sorted = [...gaps].sort((a, b) => a - b);
    runs.scrollLongFrames.push(gaps.filter((g) => g > 50).length);
    runs.scrollP95.push(sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null);
    runs.scrollLongMs.push(scrolled.longtaskTotalMs);
    console.error("  scroll", height, gaps.length);
    await scroller.evaluate((el) => el && (el.scrollTop = 0));

    // Typing into the note open, Inbox's rows beside it.
    await page.goto(`${BASE}/app${inboxHref}`);
    await rowsDrawn(page, row, total);
    await editor(page).waitFor({ timeout: 15_000 });
    await editor(page).click();
    await page.keyboard.press("End");
    await page.waitForTimeout(800);
    await perfReset(page);
    for (const char of "一覧のメモが多いときに打つと遅くなるかどうかを確かめるための文です。abcdefghij0123456789") {
      await page.keyboard.insertText(char);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(2000);
    const typed = await perfCollect(page);
    console.error("  type", typed.latencyP95);
    runs.typeP50.push(typed.latencyP50);
    runs.typeP95.push(typed.latencyP95);
    runs.typeLongMs.push(typed.longtaskTotalMs);
  }
  await context.close();
  return Object.fromEntries(Object.entries(runs).map(([key, values]) => [key, median(values)]));
}

const browser = await chromium.launch();
const MODES = (args.modes ?? "explorer,list").split(",");
const results = { runs: RUNS, cpuSlow: 4, modes: {} };
for (const mode of MODES) {
  results.modes[mode] = {};
  for (const count of COUNTS) {
    const started = Date.now();
    results.modes[mode][count] = await measureCount(browser, count, mode).catch((error) => ({ error: String(error).slice(0, 300) }));
    console.log(mode, count, JSON.stringify(results.modes[mode][count]), `${Math.round((Date.now() - started) / 1000)}s`);
  }
}
await browser.close();
mkdirSync("scripts/ux-explore", { recursive: true });
const out = `scripts/ux-explore/big-folder-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(out);
