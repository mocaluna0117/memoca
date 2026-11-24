// Opening a note in the editor: from another note, by its row in the sidebar,
// until its text is drawn, and what the CPU does meanwhile (by function and
// chunk, and inside any long task). A short note and one of 300 lines, the
// CPU 4× slower, opened alternately `--runs` times; the median time and the
// last run's profile.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/profile-open.mjs [--runs=3] [--notes=300] [--renders] [--save=dir] [--quiet]
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  PERF_INIT,
  RENDERS_INIT,
  createNote,
  editor,
  longTasksSince,
  openApp,
  pasteData,
  printProfile,
  seedNotes,
  signUp,
  startProfile,
  stopProfile,
} from "./lib.mjs";

const arg = (name, fallback) => process.argv.find((each) => each.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const RUNS = Number(arg("runs", 3));
const save = arg("save", null);
const renders = process.argv.includes("--renders");
const quiet = process.argv.includes("--quiet");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ja-JP" });
await context.addInitScript(PERF_INIT);
if (renders) await context.addInitScript(RENDERS_INIT);
const page = await context.newPage();
page.on("console", (m) => m.text().startsWith("[open]") && console.log(m.text()));
await signUp(page);
await openApp(page);
const seeded = Number(arg("notes", 0));
if (seeded > 0) await seedNotes(page, seeded);
const cdp = await context.newCDPSession(page);

const NOTES = {
  short: { title: "短いメモ", first: "短いメモの本文" },
  long: { title: "長いメモ", first: "長いメモの一行目" },
};
await createNote(page, NOTES.short.title, NOTES.short.first);
await createNote(page, NOTES.long.title);
await editor(page).click();
const html = [
  `<p>${NOTES.long.first}</p>`,
  ...Array.from({ length: 300 }, (_, i) =>
    i % 25 === 0
      ? `<h2>見出し ${i / 25 + 1}</h2>`
      : i % 7 === 0
        ? `<ul><li>箇条書きの ${i + 1} 行目です。</li></ul>`
        : `<p>${i + 1} 行目のテキストです。少し長めの文章で、折り返しが起きる程度の長さにしておきます。</p>`,
  ),
].join("");
await pasteData(page, { "text/html": html });
await page.waitForTimeout(3000);

/**
 * The note's row clicked, and the time until its text is drawn (its first
 * line in the editor), all in the page: Playwright's own locators, polled
 * meanwhile, were a good part of what the profile showed.
 */
const open = (note) =>
  page.evaluate(
    ({ title, first }) =>
      new Promise((resolve) => {
        const target = [...document.querySelectorAll("[data-tree-note], #note-list-pane button")].find(
          (element) => element.offsetParent !== null && element.textContent.includes(title),
        );
        performance.clearMarks();
        const at = performance.now();
        target.click();
        const look = () => {
          const body = document.querySelector(".memoca-editor .ProseMirror");
          if (body?.firstElementChild?.textContent.includes(first)) {
            const total = Math.round(performance.now() - at);
            // Any marks the page left on the way (performance.mark, put in to look into it).
            const marks = performance.getEntriesByType("mark").map((m) => `${m.name}@${Math.round(m.startTime - at)}`);
            if (marks.length) console.log(`[open] ${title} ${total}ms ${marks.join(" ")}`);
            resolve(total);
          }
          else requestAnimationFrame(look);
        };
        look();
      }),
    note,
  );

// Each opened once first: what is left to save of the note just written
// (its first line, when it changed) is saved as it closes, and moves it in
// the list; that once is not what opening a note costs.
for (const name of ["short", "long", "short", "long"]) {
  await open(NOTES[name]);
  await page.waitForTimeout(1500);
}

await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
const times = { short: [], long: [] };
let last = {};
for (let run = 0; run < RUNS; run += 1) {
  for (const name of ["short", "long"]) {
    const note = NOTES[name];
    await page.waitForTimeout(1500);
    if (renders) await page.evaluate(() => window.__uxRenders.start());
    const started = await startProfile(cdp, page);
    times[name].push(await open(note));
    await page.waitForTimeout(1200);
    const profiled = await stopProfile(cdp, started);
    last[name] = { profiled, hitches: await longTasksSince(page, started.mark) };
    if (renders && run === RUNS - 1) {
      const counted = await page.evaluate(() => window.__uxRenders.stop());
      const begun = await page.evaluate(() => window.__uxRenders.starts());
      console.log(`\n=== ${name}: where renders start (component#hook × times)`);
      console.log(begun.slice(0, 40).map(([where, n]) => `${where}×${n}`).join("  "));
      console.log(`\n=== ${name}: renders while opening (component × times)`);
      console.log(counted.slice(0, 80).map(([component, n]) => `${component}×${n}`).join("  "));
    }
  }
}
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const name of ["short", "long"]) {
  console.log(`${name}: opened in ${median(times[name])} ms (median of ${JSON.stringify(times[name])})`);
  if (save) writeFileSync(`${save}/open-${name}.json`, JSON.stringify(last[name].profiled));
  if (!quiet) printProfile(`${name}: opening`, last[name].profiled, "", last[name].hitches);
}
await browser.close();
