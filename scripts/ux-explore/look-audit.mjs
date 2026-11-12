// Every look, light and dark, measured rather than looked at: the contrast
// of what is read (WCAG's ratio) against what it is drawn on, in a note with
// one of each kind of line, and of the app's own pairs of colours.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/look-audit.mjs [--looks=cute,retro] [--shots=<dir>] [--pdf=<dir>]
//
// Prints the pairs under what is asked of them (4.5 for text, 3 for large
// text and marks), and writes look-audit-<time>.json. --shots keeps a
// picture of each; --pdf exports the note as a PDF in each look, dark.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { BASE, chooseLook, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const LOOKS = (args.looks ?? "stylish,cute,natural,fresh,retro,wafu,pop,chic,terminal").split(",");
if (args.shots) mkdirSync(args.shots, { recursive: true });
if (args.pdf) mkdirSync(args.pdf, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", acceptDownloads: true });
const page = await context.newPage();
await signUp(page);
await page.evaluate(() => localStorage.setItem("memoca:sidebar-mode", "explorer"));
await page.goto(BASE + "/app");
await page.getByText("同期済み").first().waitFor({ timeout: 30_000 });

// A note with one of each kind of line, some coloured by hand.
await page.locator('aside [aria-label="メモを追加"]').click();
await page.getByLabel("メモのタイトル").fill("デザインの確認");
const editor = page.locator('[contenteditable="true"]').first();
await editor.click();
for (const line of ["# 見出し 1", "## 見出し 2", "- 箇条書き", "1. 番号付き", "[] チェック項目", "> 引用の文", "ふつうの文と https://example.com "]) {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}
await page.keyboard.type("``` ");
await page.keyboard.type("const code = 1;");
await page.waitForTimeout(1200);
const note = new URL(page.url()).searchParams.get("n");

/** In the page: each pair's colours as drawn (alpha over what is under it), and their contrast. */
const measure = () =>
  page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    /** `layers` painted one over another, from white: the colour seen. */
    const seen = (layers) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1, 1);
      for (const layer of layers) {
        ctx.fillStyle = "#000";
        ctx.fillStyle = layer;
        ctx.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    /** The backgrounds under an element, outermost first. */
    const under = (el) => {
      const layers = [];
      for (let at = el; at; at = at.parentElement) {
        const bg = getComputedStyle(at).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.unshift(bg);
      }
      return layers;
    };
    const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
    const out = [];
    const el = (name, selector, need, pseudo) => {
      const node = document.querySelector(selector);
      if (!node) {
        out.push({ name, missing: true });
        return;
      }
      const layers = under(node);
      const back = seen(layers);
      const color = getComputedStyle(node, pseudo).color;
      const front = seen([...layers, color]);
      out.push({ name, need, ratio: ratio(front, back), front: hex(front), back: hex(back) });
    };
    const root = getComputedStyle(document.documentElement);
    const bn = getComputedStyle(document.querySelector(".bn-root") ?? document.documentElement);
    const pair = (name, front, back, need, from = root) => {
      const b = seen([from.getPropertyValue(back) || root.getPropertyValue(back)]);
      const f = seen([from.getPropertyValue(back) || root.getPropertyValue(back), from.getPropertyValue(front) || root.getPropertyValue(front)]);
      out.push({ name, need, ratio: ratio(f, b), front: hex(f), back: hex(b) });
    };
    const E = ".bn-editor ";
    el("本文", E + '[data-content-type="paragraph"] .bn-inline-content', 4.5);
    el("見出し 1", E + '[data-content-type="heading"] .bn-inline-content', 3);
    el("見出し 2", E + '[data-content-type="heading"][data-level="2"] .bn-inline-content', 3);
    el("箇条書きの文字", E + '[data-content-type="bulletListItem"] .bn-inline-content', 4.5);
    el("箇条書きの点", E + '[data-content-type="bulletListItem"]', 3, "::before");
    el("番号", E + '[data-content-type="numberedListItem"]', 3, "::before");
    el("チェック項目の文字", E + '[data-content-type="checkListItem"] .bn-inline-content', 4.5);
    el("引用の文字", E + '[data-content-type="quote"] blockquote', 4.5);
    el("リンク", E + "a", 4.5);
    el("コードブロックの文字", E + '[data-content-type="codeBlock"] code', 4.5);
    el("メモのタイトル", '[aria-label="メモのタイトル"]', 4.5);
    el("サイドバーの「フォルダ」", "aside h2", 4.5);
    el("サイドバーの行（選んだメモ）", 'aside [aria-current="page"], aside [data-selected="true"], aside .bg-accent', 4.5);
    el("同期の表示", '[role="status"]', 4.5);
    pair("ボタン（主）の文字", "--primary-foreground", "--primary", 4.5);
    pair("うすい文字（説明）", "--muted-foreground", "--background", 4.5);
    pair("うすい文字（うすい背景の上）", "--muted-foreground", "--muted", 4.5);
    pair("選んだ行の文字", "--accent-foreground", "--accent", 4.5);
    pair("サイドバーの文字", "--sidebar-foreground", "--sidebar", 4.5);
    pair("メニューの文字", "--popover-foreground", "--popover", 4.5);
    pair("削除などの赤", "--destructive", "--background", 3);
    pair("Todo：期限切れ", "--destructive", "--background", 3);
    pair("Todo：今日", "--todo-today", "--background", 3);
    for (const colour of ["gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"]) {
      pair(`文字の色：${colour}`, `--bn-colors-highlights-${colour}-text`, "--background", 3, bn);
    }
    return out;
  });

const results = [];
for (const look of LOOKS) {
  await chooseLook(page, look);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.goto(`${BASE}/app?n=${note}`);
    await page.getByLabel("メモのタイトル").waitFor();
    await page.waitForFunction((s) => (document.documentElement.dataset.style ?? "stylish") === s, look);
    await page.waitForTimeout(900);
    const pairs = await measure();
    results.push({ look, theme, pairs });
    const low = pairs.filter((p) => !p.missing && p.ratio < p.need);
    const missing = pairs.filter((p) => p.missing).map((p) => p.name);
    console.log(
      `${look}/${theme}: ${low.length ? low.map((p) => `${p.name} ${p.ratio}（${p.front} / ${p.back}）`).join("、") : "低いものなし"}${missing.length ? ` [なし: ${missing.join(", ")}]` : ""}`,
    );
    if (args.shots) await page.screenshot({ path: join(args.shots, `${theme}-${look}.png`) });
    if (args.pdf && theme === "dark") {
      const download = page.waitForEvent("download", { timeout: 60_000 });
      await page.getByRole("button", { name: "メモの操作" }).click();
      await page.getByRole("menuitem", { name: "PDF で書き出す" }).click();
      await (await download).saveAs(join(args.pdf, `${look}.pdf`));
      await page.waitForTimeout(500);
    }
  }
}
await browser.close();
const out = join(import.meta.dirname, `look-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`wrote ${out}`);
