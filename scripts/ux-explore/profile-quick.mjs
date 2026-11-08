// Where the quick note's time goes: a CPU profile of opening /quick and of
// typing into it (by inserted text, and through an input method's
// composition, as Japanese is typed), on a phone with the CPU 4× slower.
// Self time summed by function and by package.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/profile-quick.mjs [--lines=0]
import { chromium, devices } from "@playwright/test";
import { BASE, PERF_INIT, openApp, perfCollect, perfReset, signUp } from "./lib.mjs";

const LINES = Number(process.argv.find((arg) => arg.startsWith("--lines="))?.split("=")[1] ?? 0);

/** The package a script belongs to, by its URL and the function's name. */
function packageOf(node) {
  const { url, functionName } = node.callFrame;
  if (!url) return functionName.startsWith("(") ? functionName : "(native)";
  return url.replace(/^.*\/_next\/static\/chunks\//, "chunk:").replace(/\?.*$/, "");
}

/**
 * Self time by function and by chunk, from a profile, the longest first;
 * `within`, only of samples in those windows (ms from the profile's start).
 */
function summarise(profile, top = 25, within = null) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const deltas = profile.timeDeltas;
  let at = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    at += (deltas[index] ?? 0) / 1000;
    if (within && !within.some(([from, to]) => at >= from && at <= to)) continue;
    const node = byId.get(profile.samples[index]);
    const ms = (deltas[index] ?? 0) / 1000;
    self.set(node, (self.get(node) ?? 0) + ms);
  }
  const byFunction = new Map();
  const byChunk = new Map();
  for (const [node, ms] of self) {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    if (functionName === "(idle)" || functionName === "(program)") continue;
    const key = `${functionName || "(anonymous)"} ${url ? `${url.split("/").pop()}:${lineNumber}:${columnNumber}` : ""}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + ms);
    const chunk = packageOf(node);
    byChunk.set(chunk, (byChunk.get(chunk) ?? 0) + ms);
  }
  const sorted = (map) =>
    [...map].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, ms]) => `${ms.toFixed(1).padStart(8)}ms  ${name}`);
  const busy = [...self].filter(([n]) => !["(idle)", "(program)"].includes(n.callFrame.functionName)).reduce((a, [, ms]) => a + ms, 0);
  return { busyMs: Math.round(busy), functions: sorted(byFunction), chunks: sorted(byChunk, 12) };
}

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["Pixel 7"], locale: "ja-JP" });
await context.addInitScript(PERF_INIT);
const page = await context.newPage();
await signUp(page);
await openApp(page);
await page.goto(BASE + "/quick");
await page.getByLabel("即席メモ", { exact: true }).waitFor();
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });

// Opening: from the app to the quick note ready to type into.
await page.goto(BASE + "/app");
await page.getByRole("heading", { name: "すべてのメモ" }).first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
await cdp.send("Profiler.start");
await page.goto(BASE + "/quick");
await page.waitForFunction(() => document.querySelector('[aria-label="即席メモ"]')?.isContentEditable);
const ready = await page.evaluate(() => Math.round(performance.now()));
const opening = (await cdp.send("Profiler.stop")).profile;

const field = page.getByLabel("即席メモ", { exact: true });
await field.click();
if (LINES > 0) {
  for (let line = 0; line < LINES; line += 1) {
    await page.keyboard.insertText(`${line + 1} 行目のメモです。少し長めに書いておきます。`);
    await page.keyboard.press("Enter");
  }
}
await page.waitForTimeout(1500);

// The first key alone: whatever is made ready only once something is typed.
await cdp.send("Profiler.start");
await page.keyboard.type("最");
await page.waitForTimeout(400);
const firstKey = (await cdp.send("Profiler.stop")).profile;
await page.keyboard.press("Backspace");
await page.waitForTimeout(800);

// Typing by inserted text, as the earlier measure did.
await perfReset(page);
await cdp.send("Profiler.start");
const typingFrom = await page.evaluate(() => performance.now());
const text = "入力の遅延を測ります。日本語の文章を二百文字ほど打ちます。".repeat(8).slice(0, 200);
await page.keyboard.type(text, { delay: 30 });
await page.waitForTimeout(800);
const typed = (await cdp.send("Profiler.stop")).profile;
const typedPerf = await perfCollect(page);
// The long tasks while typing, as windows of the profile, and which key each came at.
const hitches = await page.evaluate((from) => {
  const ux = window.__ux;
  return ux.longtasks
    .filter((task) => task.start >= from)
    .map((task) => ({ from: task.start - from, to: task.start - from + task.duration, ms: Math.round(task.duration) }));
}, typingFrom);

// Typing through composition: each kana as the input method shows it, then the word committed.
const words = [
  ["き", "きょ", "きょう", "きょうは"],
  ["あ", "あめ", "あめが"],
  ["ふ", "ふっ", "ふって", "ふってい", "ふっていま", "ふっています"],
];
const commits = ["今日は", "雨が", "降っています"];
await perfReset(page);
await cdp.send("Profiler.start");
for (let round = 0; round < 6; round += 1) {
  for (const [index, steps] of words.entries()) {
    for (const step of steps) {
      await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
      await page.waitForTimeout(40);
    }
    await cdp.send("Input.insertText", { text: commits[index] });
    await page.waitForTimeout(40);
  }
}
await page.waitForTimeout(800);
const composed = (await cdp.send("Profiler.stop")).profile;
const composedPerf = await perfCollect(page);
await browser.close();

const report = (name, profile, extra) => {
  const summary = summarise(profile);
  console.log(`\n=== ${name}: busy ${summary.busyMs}ms ${extra ?? ""}`);
  console.log("-- chunks");
  for (const line of summary.chunks) console.log(line);
  console.log("-- functions");
  for (const line of summary.functions) console.log(line);
};
report("opening", opening, `(ready at ${ready}ms)`);
report("the first key", firstKey);
report("typing 200 chars", typed, JSON.stringify(typedPerf));
console.log("\n--- hitches while typing:", JSON.stringify(hitches.map((h) => ({ at: Math.round(h.from), ms: h.ms }))));
if (hitches.length > 0) {
  const inside = summarise(typed, 20, hitches.map((h) => [h.from - 5, h.to + 5]));
  console.log(`=== inside the hitches: busy ${inside.busyMs}ms`);
  inside.functions.forEach((line) => console.log(line));
}
report("composing 6×3 words", composed, JSON.stringify(composedPerf));
