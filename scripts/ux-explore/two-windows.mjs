// The desktop app's two windows, /app and /quick, open together on one
// account with many notes: what the one not being used does meanwhile. A
// window put away is the one a machine short of memory pays for: each thing
// it does brings its pages back in from swap.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/two-windows.mjs [--notes=3000] [--idle=60] [--hidden=1]
//
// Counts, not timings (they hold whatever the machine's load): requests to
// the local database by table, in each window, while both sit idle, and
// while 200 characters are typed into the quick note; with them, the script
// time and long tasks of the /app window, typed into by nobody.
// --hidden=1: /app says it is hidden (document.visibilityState), as a window
// put away does.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { BASE, PERF_INIT, openApp, seedNotes, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const NOTES = Number(args.notes ?? 3000);
const IDLE = Number(args.idle ?? 60);
const HIDDEN = args.hidden === "1";

/** Every request to IndexedDB counted, by table (and index) and by what is asked. */
const IDB_INIT = `
(() => {
  const counts = (window.__idb = {});
  const bump = (store, op) => { const key = store + "." + op; counts[key] = (counts[key] ?? 0) + 1; };
  const wrap = (proto, nameOf) => {
    for (const op of ["get", "getAll", "getAllKeys", "getKey", "count", "openCursor", "openKeyCursor", "put", "add", "delete", "clear"]) {
      const original = proto[op];
      if (!original) continue;
      proto[op] = function (...rest) { bump(nameOf(this), op); return original.apply(this, rest); };
    }
  };
  wrap(IDBObjectStore.prototype, (store) => store.name);
  wrap(IDBIndex.prototype, (index) => index.objectStore.name + "#" + index.name);
  const next = IDBCursor.prototype.continue;
  IDBCursor.prototype.continue = function (...rest) {
    const source = this.source;
    bump(source.objectStore ? source.objectStore.name + "#" + source.name : source.name, "continue");
    return next.apply(this, rest);
  };
})();`;

/** A window that says it is put away, from here on. */
const HIDE = () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.hasFocus = () => false;
  document.dispatchEvent(new Event("visibilitychange"));
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ja-JP" });
await context.addInitScript(IDB_INIT);
await context.addInitScript(PERF_INIT);
const app = await context.newPage();
await signUp(app);
await openApp(app);
await seedNotes(app, NOTES);
const quick = await context.newPage();
await quick.goto(BASE + "/quick?window=1");
const field = quick.locator('[contenteditable="true"]').first();
await field.waitFor({ timeout: 30_000 });
await field.click();
await quick.keyboard.type("はじめの一行");
await quick.waitForTimeout(8000);
if (HIDDEN) await app.evaluate(HIDE);
await quick.bringToFront();
await quick.waitForTimeout(3000);

const cdp = { app: await context.newCDPSession(app), quick: await context.newCDPSession(quick) };
for (const session of Object.values(cdp)) await session.send("Performance.enable");
const metrics = async (session) => {
  const { metrics } = await session.send("Performance.getMetrics");
  const of = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { scriptMs: of("ScriptDuration") * 1000, taskMs: of("TaskDuration") * 1000, heapMB: of("JSHeapUsedSize") / 1048576, nodes: of("Nodes") };
};
const reset = async (page) =>
  page.evaluate(() => {
    for (const key of Object.keys(window.__idb)) delete window.__idb[key];
    window.__ux.longtasks = [];
  });
const read = async (page) =>
  page.evaluate(() => ({ idb: { ...window.__idb }, longtasks: window.__ux.longtasks.map((task) => Math.round(task.duration)) }));
const total = (idb) => Object.values(idb).reduce((sum, count) => sum + count, 0);
const top = (idb, count = 8) =>
  Object.entries(idb).sort((a, b) => b[1] - a[1]).slice(0, count).map(([key, value]) => `${key}=${value}`).join(" ");

async function phase(name, during) {
  await reset(app);
  await reset(quick);
  const before = { app: await metrics(cdp.app), quick: await metrics(cdp.quick) };
  await during();
  const after = { app: await metrics(cdp.app), quick: await metrics(cdp.quick) };
  const seen = { app: await read(app), quick: await read(quick) };
  const result = { name };
  for (const side of ["app", "quick"]) {
    result[side] = {
      idbRequests: total(seen[side].idb),
      idb: seen[side].idb,
      scriptMs: Math.round(after[side].scriptMs - before[side].scriptMs),
      taskMs: Math.round(after[side].taskMs - before[side].taskMs),
      longtasks: seen[side].longtasks,
      heapMB: Math.round(after[side].heapMB * 10) / 10,
      nodes: after[side].nodes,
    };
    console.log(`${name} ${side}: idb ${result[side].idbRequests} (${top(seen[side].idb)}) script ${result[side].scriptMs}ms task ${result[side].taskMs}ms longtasks ${JSON.stringify(seen[side].longtasks)} heap ${result[side].heapMB}MB nodes ${result[side].nodes}`);
  }
  return result;
}

const results = { notes: NOTES, hidden: HIDDEN, idleSeconds: IDLE, phases: [] };
results.phases.push(await phase(`idle ${IDLE}s`, () => quick.waitForTimeout(IDLE * 1000)));
results.phases.push(
  await phase("typing 200 in /quick", async () => {
    const text = "入力の遅延を測ります。日本語の文章を二百文字ほど打ちます。".repeat(8).slice(0, 200);
    await quick.keyboard.type(text, { delay: 30 });
    await quick.waitForTimeout(4000);
  }),
);
results.phases.push(await phase(`idle after ${IDLE}s`, () => quick.waitForTimeout(IDLE * 1000)));
await browser.close();
const out = args.out ?? join(import.meta.dirname, `two-windows-${NOTES}${HIDDEN ? "-hidden" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`wrote ${out}`);
