// node run.mjs --device=desktop|pixel7 [--only=a,b] [--out=findings.json]
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "@playwright/test";
import { PERF_INIT, Run, openApp, signUp } from "./lib.mjs";
import { scenarios } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const device = args.device ?? "desktop";
const only = args.only ? new Set(args.only.split(",")) : null;
const out = args.out ?? join(here, `findings-${device}-${Date.now()}.json`);

const descriptor = device === "pixel7" ? devices["Pixel 7"] : devices["Desktop Chrome"];
const browser = await chromium.launch();
const results = [];
for (const scenario of scenarios) {
  if (!scenario.devices.includes(device)) continue;
  if (only && !only.has(scenario.name)) continue;
  const context = await browser.newContext({ ...descriptor, locale: "ja-JP" });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  // --no-offscreen: the page's own image path, as a browser without OffscreenCanvas.
  if ("no-offscreen" in args) {
    await page.addInitScript(() => { window.OffscreenCanvas = undefined; });
  }
  const fetched = { worker: 0, wasm: 0 };
  page.on("request", (r) => { const u = r.url(); if (u.includes("/webp/") && u.endsWith("webp-worker.js")) fetched.worker += 1; if (u.endsWith("webp_enc.wasm")) fetched.wasm += 1; });
  page.on("worker", (w) => { (fetched.workers ??= []).push(w.url().split("/").slice(-2).join("/")); });
  page.on("console", (m) => { if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 160)); });
  // Perf scenarios run with the CPU slowed, as a phone or a busy laptop is.
  if (scenario.cpuSlow) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: scenario.cpuSlow });
  }
  const run = new Run(scenario.name, device, here);
  run.page = page;
  const started = Date.now();
  try {
    await signUp(page);
    await openApp(page);
    await scenario.run(page, run);
  } catch (error) {
    await run.step("crash", "シナリオが最後まで走る", async () => { throw error; });
  }
  const errors = await page.evaluate(() => window.__ux?.errors ?? []).catch(() => []);
  if (errors.length) run.findings.push({ scenario: scenario.name, device, step: "page-errors", expected: "なし", actual: errors, ok: false });
  for (const f of run.findings) if (f.step === "perf") f.actual = { ...f.actual, fetched };
  results.push(...run.findings);
  console.log(`${scenario.name} (${device}) ${Date.now() - started}ms: ${run.findings.map((f) => `${f.step}=${f.ok === null ? "seen" : f.ok ? "ok" : "NG"}`).join(" ")}`);
  await context.close();
}
await browser.close();
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`wrote ${out}`);
