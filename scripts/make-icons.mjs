/**
 * Renders the app icons once and writes them to public/icons.
 *
 * Run with `node scripts/make-icons.mjs` after changing the mark. The output is
 * committed, so a normal build and deploy never needs a browser.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

/** @param {{size:number, padRatio:number}} opts */
const markup = ({ size, padRatio }) => {
  const inset = Math.round(size * padRatio);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;}
  .plate{
    width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(145deg,#1e293b 0%,#0f172a 55%,#020617 100%);
  }
  svg{width:${size - inset * 2}px;height:${size - inset * 2}px;display:block;}
</style></head>
<body><div class="plate">
  <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 8h40l20 20v58a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6z"
          fill="#f8fafc"/>
    <path d="M60 8l20 20H64a4 4 0 0 1-4-4V8z" fill="#cbd5e1"/>
    <rect x="26" y="34" width="34" height="6" rx="3" fill="#94a3b8"/>
    <rect x="26" y="48" width="24" height="6" rx="3" fill="#cbd5e1"/>
    <path d="M55 70v-7a9 9 0 0 1 18 0v7" stroke="#0ea5e9" stroke-width="6"
          stroke-linecap="round"/>
    <rect x="49" y="68" width="30" height="22" rx="6" fill="#0ea5e9"/>
    <circle cx="64" cy="79" r="3.4" fill="#0f172a"/>
  </svg>
</div></body></html>`;
};

const shots = [
  { file: "icon-512.png", size: 512, padRatio: 0.16 },
  { file: "icon-192.png", size: 192, padRatio: 0.16 },
  // Android crops maskable icons to a circle, so the mark keeps well inside.
  { file: "maskable-512.png", size: 512, padRatio: 0.26 },
  { file: "apple-icon.png", size: 180, padRatio: 0.14 },
  { file: "favicon-64.png", size: 64, padRatio: 0.1 },
];

const browser = await chromium.launch();
await mkdir("public/icons", { recursive: true });

for (const shot of shots) {
  const page = await browser.newPage({
    viewport: { width: shot.size, height: shot.size },
    deviceScaleFactor: 1,
  });
  await page.setContent(markup(shot));
  await writeFile(`public/icons/${shot.file}`, await page.screenshot());
  await page.close();
  console.log("wrote", shot.file, `${shot.size}x${shot.size}`);
}

await browser.close();
