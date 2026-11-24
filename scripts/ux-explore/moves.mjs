// Each move within the app (the sidebar's icons, a search hit opened, back
// and forward): how long until the page is drawn, and which requests went
// to our server for it. --latency=400 makes every request to the server
// wait that long, as from Japan to Vercel's function in iad1 (Chromium only).
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/moves.mjs [--latency=400] [--engine=webkit] [--notes=300] [--slow=4]
import { chromium, webkit } from "@playwright/test";
import { BASE, createNote, openApp, seedNotes, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const LATENCY = Number(args.latency ?? 0);
const ENGINE = args.engine ?? "chromium";
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await signUp(page);
// --slow=4: the CPU that many times slower (Chromium only).
if (args.slow) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(args.slow) });
}
await openApp(page);
// --notes=300: that many more on this device (seedNotes), as a list and an index of a real size.
if (args.notes) await seedNotes(page, Number(args.notes));
await createNote(page, "買い物リスト", "牛乳と卵を買う");
await createNote(page, "旅行の計画", "京都に行く");

// Every request to our own server (not Convex), after the page is up.
let log = [];
let delayed = 0;
page.on("request", (r) => {
  const url = new URL(r.url());
  if (url.origin === new URL(BASE).origin && !url.pathname.startsWith("/_next/static")) {
    log.push(`${r.method()} ${url.pathname}${url.search.slice(0, 40)} ${r.headers()["rsc"] ? "[RSC]" : ""}`);
  }
});
if (LATENCY && ENGINE === "chromium") {
  // The server is far: every request to it waits (Vercel's function in iad1, from Japan).
  await page.route(`${BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/_next/static")) {
      delayed += 1;
      await new Promise((r) => setTimeout(r, LATENCY));
    }
    await route.continue();
  });
}
await page.waitForTimeout(1500);

async function step(name, act, ready) {
  log = [];
  delayed = 0;
  const started = Date.now();
  await act();
  await ready();
  const ms = Date.now() - started;
  await page.waitForTimeout(600);
  console.log(`${name}: ${ms} ms, delayed ${delayed}, server requests: ${log.length}${log.length ? "\n  " + log.join("\n  ") : ""}`);
}

const nav = page.locator("aside nav");
// A note opened from the list beside it, the notes page as it is: the editor's part alone.
await step(
  "list → another note",
  () =>
    page
      .locator("[data-tree-note], #note-list-pane button")
      .filter({ hasText: "買い物リスト", visible: true })
      .first()
      .click(),
  () => page.locator('[contenteditable="true"]', { hasText: "牛乳と卵を買う" }).first().waitFor(),
);
await step(
  "sidebar → 検索",
  () => nav.getByRole("link", { name: "検索" }).click(),
  () => page.getByRole("textbox", { name: "検索" }).waitFor(),
);
await step(
  "sidebar → ゴミ箱",
  () => nav.getByRole("link", { name: "ゴミ箱" }).click(),
  () => page.getByRole("heading", { name: "ゴミ箱" }).first().waitFor(),
);
await step(
  "sidebar → 検索 (again)",
  () => nav.getByRole("link", { name: "検索" }).click(),
  () => page.getByRole("textbox", { name: "検索" }).waitFor(),
);
await page.getByRole("textbox", { name: "検索" }).fill("牛乳");
await page.getByRole("button", { name: /買い物リスト/ }).first().waitFor();
await step(
  "search hit → note",
  () => page.getByRole("button", { name: /買い物リスト/ }).first().click(),
  () => page.locator('[contenteditable="true"]', { hasText: "牛乳と卵を買う" }).first().waitFor(),
);
await step(
  "back",
  () => page.goBack(),
  () => page.getByRole("textbox", { name: "検索" }).waitFor(),
);
await step(
  "forward",
  () => page.goForward(),
  () => page.locator('[contenteditable="true"]', { hasText: "牛乳と卵を買う" }).first().waitFor(),
);
await browser.close();
