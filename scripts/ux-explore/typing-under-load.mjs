// How late each typed character shows with the computer busy elsewhere (a
// video call, Zoom, taking the CPU): in a note and in the quick note, with
// 150 notes on the device, the CPU made six times slower. Medians of runs.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/typing-under-load.mjs [--notes=150] [--rate=6] [--runs=3] [--where=note,quick]
//   [--engine=webkit --burn=8]: the Mac app's engine, the computer kept busy by 8 spinning processes
//
// Latency: from beforeinput to the frame after it (PERF_INIT). Long tasks:
// those of 50 ms or more while typing.
import { chromium, webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { BASE, PERF_INIT, editor, perfCollect, perfReset, seedNotes, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const NOTES = Number(args.notes ?? 150);
const RATE = Number(args.rate ?? 6);
const RUNS = Number(args.runs ?? 3);
const WHERE = (args.where ?? "note,quick").split(",");
// WebKit (the Mac app's engine) cannot be slowed through CDP: the computer
// is kept busy instead, `burn` processes spinning (as a video call takes it).
const ENGINE = args.engine ?? "chromium";
const BURN = Number(args.burn ?? 0);
const TEXT = "会議のメモを取りながら打っていると遅れることがあるので確かめる。abcdefghij0123456789";
const median = (values) => {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : null;
};

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE });
await context.addInitScript(PERF_INIT);
const page = await context.newPage();
await signUp(page);
await page.goto(`${BASE}/app`);
await page.getByRole("heading", { name: "すべてのメモ" }).first().waitFor({ timeout: 30_000 });
if (NOTES > 0) await seedNotes(page, NOTES);
const noteAt = await page.evaluate(() => location.search);
const cdp = ENGINE === "chromium" ? await context.newCDPSession(page) : null;
const burners = [];
const startBurning = () => {
  for (let i = 0; i < BURN; i += 1) burners.push(spawn("yes", [], { stdio: "ignore" }));
};
const stopBurning = () => {
  for (const burner of burners.splice(0)) burner.kill();
};
process.on("exit", stopBurning);

async function run(label, open) {
  const results = [];
  for (let at = 0; at < RUNS; at += 1) {
    const field = await open();
    await field.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });
    startBurning();
    await page.waitForTimeout(BURN > 0 ? 1000 : 0);
    await perfReset(page);
    for (const char of TEXT) {
      await page.keyboard.insertText(char);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(3000);
    results.push(await perfCollect(page));
    stopBurning();
    if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
  const summary = {
    p50: median(results.map((r) => r.latencyP50)),
    p95: median(results.map((r) => r.latencyP95)),
    max: median(results.map((r) => r.latencyMax)),
    longtasks: median(results.map((r) => r.longtasks)),
    longtaskMs: median(results.map((r) => r.longtaskTotalMs)),
  };
  console.log(label, JSON.stringify(summary));
  return summary;
}

const out = { notes: NOTES, engine: ENGINE, rate: ENGINE === "chromium" ? RATE : null, burn: BURN, runs: RUNS };
if (WHERE.includes("note")) {
  out.note = await run("note", async () => {
    await page.goto(`${BASE}/app${noteAt}`);
    await editor(page).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    return editor(page);
  });
}
if (WHERE.includes("quick")) {
  out.quick = await run("quick", async () => {
    await page.goto(`${BASE}/quick?window=1`);
    const field = page.locator('[contenteditable="true"]').first();
    await field.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    return field;
  });
}
await browser.close();
if (args.save) writeFileSync(args.save, JSON.stringify(out, null, 2));
