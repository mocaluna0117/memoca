// What opening a long note costs in each look: the long tasks from the page's
// load until it is quiet, with the CPU 4× slower, and what the browser spent
// them on (styles parsed and recalculated, layout, script).
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/load-cost.mjs [--looks=stylish,cute,terminal] [--rounds=3] [--lines=300]
import { chromium, devices } from "@playwright/test";
import { PERF_INIT, chooseLook, createNote, editor, openApp, pasteData, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const LOOKS = (args.looks ?? "stylish,cute,terminal").split(",");
const ROUNDS = Number(args.rounds ?? 3);
const LINES = Number(args.lines ?? 300);
const device = args.device === "pixel7" ? devices["Pixel 7"] : devices["Desktop Chrome"];

const browser = await chromium.launch();
const context = await browser.newContext({ ...device, locale: "ja-JP" });
await context.addInitScript(PERF_INIT);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await signUp(page);
await openApp(page);
await createNote(page, "長いメモ");
await editor(page).click();
const html = Array.from(
  { length: LINES },
  (_, i) => `<p>${i + 1} 行目のテキストです。少し長めの文章で、折り返しが起きる程度の長さにしておきます。</p>`,
).join("");
await pasteData(page, { "text/html": html });
await page.waitForTimeout(2500);
const url = page.url();

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const KINDS = ["ParseAuthorStyleSheet", "UpdateLayoutTree", "Layout", "EvaluateScript", "FunctionCall", "ParseHTML", "PrePaint", "Paint"];
const table = {};
for (let round = 0; round < ROUNDS; round++) {
  for (const look of LOOKS) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await chooseLook(page, look);
    // Fresh of the network's copies each time, as a first visit is: the service worker's and the browser's.
    await cdp.send("Network.clearBrowserCache");
    await page.evaluate(async () => {
      for (const name of await caches.keys()) if (name === "memoca-fonts") await caches.delete(name);
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    let fonts = 0;
    const seen = (r) => {
      if (r.url().endsWith(".woff2")) fonts += 1;
    };
    page.on("requestfinished", seen);
    await browser.startTracing(page, { categories: ["devtools.timeline"] });
    await page.goto(url);
    await page.getByLabel("メモのタイトル").waitFor();
    await page.waitForTimeout(7000);
    const trace = JSON.parse((await browser.stopTracing()).toString());
    page.off("requestfinished", seen);
    const ux = await page.evaluate(() => window.__ux);
    const tasks = ux.longtasks.map((t) => t.duration);
    const spent = {};
    for (const e of (trace.traceEvents ?? trace).filter((e) => e.ph === "X" && KINDS.includes(e.name))) {
      spent[e.name] = (spent[e.name] ?? 0) + e.dur / 1000;
    }
    const row = {
      long: tasks.length,
      total: Math.round(tasks.reduce((a, b) => a + b, 0)),
      max: Math.round(Math.max(0, ...tasks)),
      fonts,
      ...Object.fromEntries(Object.entries(spent).map(([k, v]) => [k, Math.round(v)])),
    };
    (table[look] ??= []).push(row);
    console.log(`${look} #${round + 1}: ${JSON.stringify(row)}`);
  }
}
console.log("\nmedians:");
for (const look of LOOKS) {
  const rows = table[look];
  const keys = Object.keys(rows[0]);
  console.log(look, JSON.stringify(Object.fromEntries(keys.map((k) => [k, median(rows.map((r) => r[k] ?? 0))]))));
}
await browser.close();
