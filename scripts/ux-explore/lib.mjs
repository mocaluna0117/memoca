// Shared helpers for the UX exploration: a session against the local build,
// observations with screenshots, and input/paste timing probes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const BASE = process.env.UX_BASE ?? "http://localhost:3100";
const PASSWORD = "memoca-e2e-password";

export async function signUp(page) {
  const part = () => Math.floor(Math.random() * 254) + 1;
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.${part()}.${part()}.${part()}` });
  const email = `ux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@memoca.test`;
  await page.goto(BASE + "/");
  const status = await page.evaluate(
    async ([address, password]) => {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address, password, name: "UX" }),
      });
      return res.status;
    },
    [email, PASSWORD],
  );
  if (status >= 400) throw new Error(`sign-up failed: ${status}`);
  return email;
}

export async function openApp(page) {
  await page.goto(BASE + "/app");
  await page.getByRole("heading", { name: "すべてのメモ" }).first().waitFor({ timeout: 30_000 });
}

export const isNarrow = (page) => (page.viewportSize()?.width ?? 1280) < 768;

export async function showList(page) {
  if (!isNarrow(page)) return;
  const back = page.getByRole("button", { name: "戻る" });
  if (await back.isVisible().catch(() => false)) await back.click();
}

export const editor = (page) => page.locator('[contenteditable="true"]').first();

export async function createNote(page, title, body) {
  await showList(page);
  const current = () => new URL(page.url()).searchParams.get("n");
  const before = current();
  await page.getByRole("button", { name: "新しいメモ" }).first().click();
  const deadline = Date.now() + 10_000;
  while (current() === before && Date.now() < deadline) await page.waitForTimeout(50);
  const field = page.getByLabel("メモのタイトル");
  await field.waitFor();
  await field.fill(title);
  if (body) {
    await editor(page).click();
    await page.keyboard.type(body);
  }
  await page.waitForTimeout(700);
}

/** Each block a line: its type and text, indented by depth. Props of interest appended. */
export const outline = (page) =>
  editor(page).evaluate((root) =>
    [...root.querySelectorAll(".bn-block-content")].map((content) => {
      let depth = 0;
      for (let at = content.parentElement; at && at !== root; at = at.parentElement) {
        if (at.classList.contains("bn-block-group")) depth += 1;
      }
      const type = content.dataset.contentType ?? "";
      const text = content.querySelector(".bn-inline-content")?.textContent ?? content.textContent ?? "";
      const extra = [];
      const block = content.closest(".bn-block");
      if (content.dataset.checked) extra.push(`checked=${content.dataset.checked}`);
      if (block?.dataset.start) extra.push(`start=${block.dataset.start}`);
      const box = content.querySelector('input[type="checkbox"]');
      if (box) extra.push(`box=${box.checked}`);
      return `${"  ".repeat(Math.max(0, depth - 1))}${type}:${text}${extra.length ? " " + extra.join(" ") : ""}`;
    }),
  );

/** Caret into the first line whose text is exactly `text`, at `offset` (end by default). */
export async function caretIn(page, text, offset) {
  await editor(page)
    .locator(".bn-inline-content", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
    .first()
    .evaluate((line, offset) => {
      const node = line.firstChild;
      const range = document.createRange();
      const length = (node?.textContent ?? "").length;
      if (node && node.nodeType === Node.TEXT_NODE) range.setStart(node, offset ?? length);
      else range.setStart(line, 0);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      line.closest('[contenteditable="true"]')?.focus();
    }, offset);
}

/** Pastes clipboard data of the given types into the editor. */
export async function pasteData(page, types) {
  await editor(page).evaluate((target, types) => {
    const data = new DataTransfer();
    for (const [type, value] of Object.entries(types)) data.setData(type, value);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, types);
}

/** Pastes a generated picture (photo: gradient with grain; screen: text on white). */
export async function pastePicture(page, { width, height, kind, name = "写真.png" }) {
  await editor(page).click();
  await editor(page).evaluate(async (target, options) => {
    const canvas = document.createElement("canvas");
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext("2d");
    if (options.kind === "photo") {
      const gradient = context.createLinearGradient(0, 0, options.width, options.height);
      gradient.addColorStop(0, "#1d4ed8");
      gradient.addColorStop(1, "#f59e0b");
      context.fillStyle = gradient;
      context.fillRect(0, 0, options.width, options.height);
      const grain = context.getImageData(0, 0, options.width, options.height);
      for (let i = 0; i < grain.data.length; i += 1) {
        if (i % 4 === 3) continue;
        grain.data[i] = Math.max(0, Math.min(255, grain.data[i] + (Math.imul(i, 2654435761) >>> 28) - 8));
      }
      context.putImageData(grain, 0, 0);
    } else {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, options.width, options.height);
      context.fillStyle = "#1f2937";
      context.fillRect(0, 0, options.width, options.height * 0.06);
      context.font = `${Math.round(options.width / 26)}px sans-serif`;
      for (let line = 0, y = options.height * 0.12; y < options.height * 0.95; line += 1, y += options.width / 8) {
        context.fillStyle = line % 3 === 0 ? "#2563eb" : "#111827";
        context.fillText("明日の打ち合わせは 10:00 から、3-A 会議室で。", options.width * 0.05, y);
      }
    }
    const blob = await new Promise((resolve) => canvas.toBlob((made) => resolve(made), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], options.name, { type: "image/png" }));
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { width, height, kind, name });
}

export const noteImages = (page) => page.locator('[data-content-type="image"] img.bn-visual-media');
export const natural = (image) =>
  image.evaluate((element) => ({ w: element.naturalWidth, h: element.naturalHeight }));

export async function raiseKeyboard(page, covered = 300) {
  await page.evaluate((height) => {
    const viewport = window.visualViewport;
    Object.defineProperty(viewport, "height", { configurable: true, get: () => window.innerHeight - height });
    viewport.dispatchEvent(new Event("resize"));
  }, covered);
}

export async function swipe(page, from, to, { steps = 12, stepMs = 16 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1_000;
  const touch = (type, touchPoints, atMs) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints, timestamp: start + atMs / 1_000 });
  await touch("touchStart", [from], 0);
  for (let i = 1; i <= steps; i += 1) {
    await touch("touchMove", [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }], i * stepMs);
    await page.waitForTimeout(8);
  }
  await touch("touchEnd", [], steps * stepMs);
  await cdp.detach();
}

export async function readTable(page, table) {
  return page.evaluate(async (name) => {
    const databases = await indexedDB.databases();
    const found = databases.find((entry) => entry.name?.startsWith("memoca"));
    if (!found?.name) return [];
    const opened = await new Promise((resolve, reject) => {
      const request = indexedDB.open(found.name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!opened.objectStoreNames.contains(name)) { opened.close(); return []; }
    const rows = await new Promise((resolve, reject) => {
      const request = opened.transaction(name, "readonly").objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    opened.close();
    return JSON.parse(JSON.stringify(rows, (_k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? "[bytes]" : v)));
  }, table);
}

/* ------------------------------------------------------------- perf probes */

export const PERF_INIT = `
(() => {
  const ux = (window.__ux = { longtasks: [], latencies: [], errors: [] });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) ux.longtasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  // beforeinput, not keydown: Playwright types Japanese by inserting text, with no key events.
  window.addEventListener("beforeinput", () => {
    const at = performance.now();
    requestAnimationFrame(() => setTimeout(() => ux.latencies.push(performance.now() - at), 0));
  }, true);
  window.addEventListener("error", (e) => ux.errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => ux.errors.push("rejection: " + String(e.reason?.message ?? e.reason)));
})();`;

export async function perfReset(page) {
  await page.evaluate(() => { const ux = window.__ux; ux.longtasks = []; ux.latencies = []; ux.errors = []; });
}

const pct = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};

export async function perfCollect(page) {
  const ux = await page.evaluate(() => window.__ux);
  const durations = ux.longtasks.map((t) => t.duration);
  return {
    longtasks: ux.longtasks.length,
    longtaskTotalMs: Math.round(durations.reduce((a, b) => a + b, 0)),
    longtaskMaxMs: Math.round(Math.max(0, ...durations)),
    latencyP50: pct(ux.latencies, 50),
    latencyP95: pct(ux.latencies, 95),
    latencyMax: pct(ux.latencies, 100),
    keystrokes: ux.latencies.length,
    errors: ux.errors,
  };
}

/* ------------------------------------------------------------ observations */

export class Run {
  constructor(scenario, device, outDir) {
    this.scenario = scenario;
    this.device = device;
    this.dir = join(outDir, "shots", device);
    mkdirSync(this.dir, { recursive: true });
    this.findings = [];
    this.page = null;
  }
  async shot(name) {
    const file = join(this.dir, `${this.scenario}-${name}.png`);
    try { await this.page.screenshot({ path: file, fullPage: false }); } catch {}
    return file;
  }
  /** Records one observation. `ok` is decided by `check(actual)` when given, else recorded as "seen". */
  async step(name, expected, actualFn, check) {
    const started = Date.now();
    let actual;
    let ok = null;
    try {
      actual = await actualFn();
      if (check) ok = Boolean(check(actual));
    } catch (error) {
      actual = `ERROR: ${error?.message ?? error}`;
      ok = false;
    }
    const screenshot = await this.shot(name);
    const record = { scenario: this.scenario, device: this.device, step: name, expected, actual, ok, screenshot, timingMs: Date.now() - started };
    this.findings.push(record);
    return actual;
  }
}
