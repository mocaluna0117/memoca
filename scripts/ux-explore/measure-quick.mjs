// The quick note, measured: how long /quick takes to be ready to type into
// (its JavaScript already cached, as after the app has been opened once),
// and how long each character typed into it takes to be drawn. On a phone,
// with the CPU 4× slower, 3 rounds, medians.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/measure-quick.mjs
import { chromium, devices } from "@playwright/test";
import { BASE, PERF_INIT, openApp, perfCollect, perfReset, signUp } from "./lib.mjs";

const ROUNDS = 3;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const browser = await chromium.launch();
const loads = [];
const typing = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const context = await browser.newContext({ ...devices["Pixel 7"], locale: "ja-JP" });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  await signUp(page);
  await openApp(page);
  // Once, for its JavaScript to be cached; then measured.
  await page.goto(BASE + "/quick");
  await page.getByLabel("即席メモ", { exact: true }).waitFor();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(BASE + "/app");
  await page.getByRole("heading", { name: "すべてのメモ" }).first().waitFor({ timeout: 30_000 });
  await page.goto(BASE + "/quick");
  await page.waitForFunction(() => {
    const field = document.querySelector('[aria-label="即席メモ"]');
    return field && (field.isContentEditable || field.tagName === "TEXTAREA");
  });
  loads.push(await page.evaluate(() => Math.round(performance.now())));
  await page.getByLabel("即席メモ", { exact: true }).click();
  await page.waitForTimeout(1000);
  await perfReset(page);
  const text = "入力の遅延を測ります。日本語の文章を二百文字ほど打ちます。".repeat(8).slice(0, 200);
  await page.keyboard.type(text, { delay: 30 });
  await page.waitForTimeout(1500);
  typing.push(await perfCollect(page));
  await context.close();
}
await browser.close();
console.log(
  JSON.stringify(
    {
      base: BASE,
      readyMs: { median: median(loads), all: loads },
      latencyP50: median(typing.map((each) => each.latencyP50)),
      latencyP95: median(typing.map((each) => each.latencyP95)),
      longtaskTotalMs: median(typing.map((each) => each.longtaskTotalMs)),
      errors: typing.flatMap((each) => each.errors),
    },
    null,
    2,
  ),
);
