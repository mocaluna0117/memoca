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

/* ------------------------------------------------------------ CPU profiles */

/**
 * Starts a CPU profile and marks, in it, where the page's clock stands: a
 * short busy loop of a known name, run at a known performance.now(). Its
 * samples line the profile up with times the page records (long tasks).
 */
export async function startProfile(cdp, page) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const mark = await page.evaluate(`(function __uxMark() {
    const at = performance.now();
    while (performance.now() - at < 12) {}
    return at;
  })()`);
  return { mark };
}

/** Stops the profile started by {@link startProfile}: it, with the page time its own time 0 stands for. */
export async function stopProfile(cdp, started) {
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  let at = 0;
  let markAt = null;
  for (let index = 0; index < profile.samples.length; index += 1) {
    at += (profile.timeDeltas[index] ?? 0) / 1000;
    if (byId.get(profile.samples[index])?.callFrame.functionName === "__uxMark") {
      markAt = at;
      break;
    }
  }
  return { profile, origin: markAt === null ? null : started.mark - markAt };
}

/** The chunk a frame's script is, by its URL. */
const chunkOf = (node) => {
  const { url, functionName } = node.callFrame;
  if (!url) return functionName.startsWith("(") ? functionName : "(native)";
  return url.replace(/^.*\/_next\/static\/chunks\//, "chunk:").replace(/\?.*$/, "");
};

/**
 * Self time by function and by chunk, the longest first; `within`, only of
 * samples in those windows of page time (needs the profile's `origin`).
 */
export function summarise({ profile, origin }, { top = 25, within = null } = {}) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let at = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    at += ms;
    if (within) {
      if (origin === null) break;
      const page = origin + at;
      if (!within.some(([from, to]) => page >= from && page <= to)) continue;
    }
    const node = byId.get(profile.samples[index]);
    if (node.callFrame.functionName === "__uxMark") continue;
    self.set(node, (self.get(node) ?? 0) + ms);
  }
  const byFunction = new Map();
  const byChunk = new Map();
  let busy = 0;
  for (const [node, ms] of self) {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    if (functionName === "(idle)" || functionName === "(program)") continue;
    busy += ms;
    const key = `${functionName || "(anonymous)"} ${url ? `${url.split("/").pop()}:${lineNumber}:${columnNumber}` : ""}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + ms);
    byChunk.set(chunkOf(node), (byChunk.get(chunkOf(node)) ?? 0) + ms);
  }
  const sorted = (map, count) =>
    [...map].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, ms]) => `${ms.toFixed(1).padStart(8)}ms  ${name}`);
  return { busyMs: Math.round(busy), functions: sorted(byFunction, top), chunks: sorted(byChunk, 12) };
}

/** Long tasks the page recorded since `from` (page time), as windows. */
export async function longTasksSince(page, from) {
  return page.evaluate(
    (since) => window.__ux.longtasks.filter((task) => task.start >= since).map((task) => [task.start, task.start + task.duration]),
    from,
  );
}

/** Prints a summary, and what ran inside the long tasks, if any. */
export function printProfile(name, profiled, extra, hitches = []) {
  const summary = summarise(profiled);
  console.log(`\n=== ${name}: busy ${summary.busyMs}ms ${extra ?? ""}`);
  console.log("-- chunks");
  for (const line of summary.chunks) console.log(line);
  console.log("-- functions");
  for (const line of summary.functions) console.log(line);
  if (hitches.length > 0) {
    console.log(`--- long tasks: ${JSON.stringify(hitches.map(([from, to]) => Math.round(to - from)))}`);
    const inside = summarise(profiled, { top: 15, within: hitches.map(([from, to]) => [from - 2, to + 2]) });
    console.log(`--- inside them: busy ${inside.busyMs}ms`);
    for (const line of inside.functions) console.log(line);
  }
}

/* ------------------------------------------------------------- renders */

/**
 * Counts each React component's renders, by its name (readable in a build
 * made with `next build --no-mangling`), as React DevTools learns of them:
 * through the hook it looks for, installed before React loads. A fiber
 * rendered in a commit has the PerformedWork flag.
 */
export const RENDERS_INIT = `
(() => {
  const counts = new Map();
  /** Those drawn again with the same props: by a state, a context or a store of their own (where an update starts). */
  const starts = new Map();
  let counting = false;
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (!type || typeof type === "string") return null;
    return type.displayName || type.name || type.render?.displayName || type.render?.name || type.type?.displayName || type.type?.name || null;
  };
  const walk = (fiber) => {
    for (let at = fiber; at; at = at.sibling) {
      if (counting && (at.flags & 1) === 1 && (at.tag === 0 || at.tag === 1 || at.tag === 11 || at.tag === 14 || at.tag === 15)) {
        const name = nameOf(at);
        if (name) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          if (at.alternate && at.alternate.memoizedProps === at.memoizedProps) {
            // Which hook changed: the index of the first whose state is not the one before.
            let hook = at.memoizedState, before = at.alternate.memoizedState, index = 0, changed = -1;
            while (hook && before) {
              if (hook.memoizedState !== before.memoizedState) { changed = index; break; }
              hook = hook.next; before = before.next; index += 1;
            }
            const key = name + "#" + (changed < 0 ? "context" : changed);
            starts.set(key, (starts.get(key) ?? 0) + 1);
          }
        }
      }
      // A subtree left as it was (its children the same fibers as before) was not drawn this time.
      if (at.child && !(at.alternate && at.alternate.child === at.child)) walk(at.child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { this.renderers.set(1, renderer); return 1; },
    onCommitFiberRoot(_id, root) { if (counting) walk(root.current); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  window.__uxRenders = {
    start() { counts.clear(); starts.clear(); counting = true; },
    stop() { counting = false; return [...counts].sort((a, b) => b[1] - a[1]); },
    starts() { return [...starts].sort((a, b) => b[1] - a[1]); },
  };
})();`;

/**
 * Fills this device with `count` notes more, as a person who has used
 * Memoca a while has: copies of a note made in the app (its row as the app
 * wrote it), each with a name and a first line of its own, written straight
 * into the local database. On this device only (they are never sent), for
 * what the lists and the queries behind them cost. The page is loaded again
 * after, for what it reads to be read afresh.
 */
export async function seedNotes(page, count) {
  await createNote(page, "見本のメモ", "見本の本文です。");
  await page.waitForTimeout(1500);
  await page.evaluate(async (count) => {
    const databases = await indexedDB.databases();
    const found = databases.find((entry) => entry.name?.startsWith("memoca"));
    const opened = await new Promise((resolve, reject) => {
      const request = indexedDB.open(found.name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = await new Promise((resolve, reject) => {
      const request = opened.transaction("notes", "readonly").objectStore("notes").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const model = all.find((note) => note.title === "見本のメモ");
    const store = opened.transaction("notes", "readwrite").objectStore("notes");
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      store.put({
        ...model,
        noteId: `seed-${index}-${Math.random().toString(36).slice(2, 10)}`,
        title: `メモ ${index + 1}`,
        preview: `${index + 1} 番目のメモの一行目です。少し長めに書いておきます。`,
        sortKey: `${model.sortKey}${String(index).padStart(4, "0")}`,
        updatedAt: now - index * 60_000,
      });
    }
    await new Promise((resolve) => (store.transaction.oncomplete = resolve));
    opened.close();
  }, count);
  await page.reload();
  await page.getByRole("heading", { name: "すべてのメモ" }).first().waitFor({ timeout: 30_000 }).catch(() => {});
}
