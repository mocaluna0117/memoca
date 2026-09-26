import { expect, type Page, test } from "@playwright/test";
import asset from "../src/lib/media/webp-asset.json";
import { createNote, editor, offlineReady, openApp, signUp } from "./helpers";
import { natural, noteImages } from "./image-helpers";
import { readTable } from "./local-db";

const WORKER = `/webp/${asset.version}/webp-worker.js`;
const WASM = `/webp/${asset.version}/webp_enc.wasm`;

/** Runs the built worker on a small image in the page, and says what came back. */
function runWorker(page: Page) {
  return page.evaluate(async (url) => {
    const worker = new Worker(url);
    const pixels = new Uint8ClampedArray(16 * 16 * 4).fill(128);
    const reply = await new Promise<{ webp?: ArrayBuffer; error?: string }>((resolve) => {
      worker.onmessage = (event) => {
        if (!("ready" in event.data)) resolve(event.data);
      };
      worker.onerror = (event) => resolve({ error: event.message || "worker failed to load" });
      worker.postMessage({ id: 1, width: 16, height: 16, pixels: pixels.buffer, quality: 80 }, [pixels.buffer]);
    });
    worker.terminate();
    if (!reply.webp) return { error: reply.error ?? "no file" };
    const bytes = new Uint8Array(reply.webp);
    const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
    return { riff: text(0, 4), kind: text(8, 12) };
  }, WORKER);
}

/** The paths the service worker keeps in its precache, or in the encoder's own cache. */
function cachedPaths(page: Page, which: "precache" | "encoder") {
  return page.evaluate(async (kind) => {
    const names = (await caches.keys()).filter((name) =>
      kind === "precache" ? name.includes("precache") : name === "memoca-webp",
    );
    const paths: string[] = [];
    for (const name of names) {
      for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths.sort();
  }, which);
}

/**
 * Pastes a photo-like picture, a gradient with grain, as PNG: large as a PNG,
 * much smaller as WebP, so which of the two was kept says which was written.
 */
async function pastePhoto(page: Page) {
  await editor(page).click();
  await editor(page).evaluate(async (target) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 800, 600);
    gradient.addColorStop(0, "#1d4ed8");
    gradient.addColorStop(1, "#f59e0b");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 800, 600);
    const grain = context.getImageData(0, 0, 800, 600);
    for (let i = 0; i < grain.data.length; i += 4) {
      const shift = ((i * 2654435761) % 17) - 8;
      grain.data[i] = Math.max(0, Math.min(255, grain.data[i]! + shift));
    }
    context.putImageData(grain, 0, 0);
    // Asked for PNG, which the Safari-like canvas below writes as asked.
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "photo.png", { type: "image/png" }));
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
}

test.describe("the WebP worker", () => {
  test("writes WebP in a real browser, from the files the build put in place", async ({ page }) => {
    await page.goto("/");
    expect(await runWorker(page)).toMatchObject({ riff: "RIFF", kind: "WEBP" });
  });

  test("writes an image added to a note where the canvas cannot, as in Safari", async ({ page }) => {
    // Safari's canvas, asked for WebP, quietly writes a PNG. Asking it at
    // full size is counted: the app should not, knowing it cannot.
    await page.addInitScript(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      (window as unknown as { webpAsked: number }).webpAsked = 0;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        if (type === "image/webp" && this.width * this.height > 1) {
          (window as unknown as { webpAsked: number }).webpAsked += 1;
        }
        return toBlob.call(this, callback, type === "image/webp" ? "image/png" : type, quality);
      };
    });
    await signUp(page);
    await openApp(page);
    await createNote(page, "Safari のような写真");
    const workerFetched = page.waitForRequest((request) => new URL(request.url()).pathname === WORKER);
    await pastePhoto(page);
    await workerFetched;
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({ w: 800, h: 600 });
    await expect
      .poll(async () => (await readTable<{ mime: string }>(page, "attachments")).map((row) => row.mime))
      .toEqual(["image/webp"]);
    expect(await page.evaluate(() => (window as unknown as { webpAsked: number }).webpAsked)).toBe(0);
  });

  test("is not downloaded with the app, but kept once used, and works offline after that", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    expect((await cachedPaths(page, "precache")).filter((path) => path.startsWith("/webp/"))).toEqual([]);

    expect(await runWorker(page)).toMatchObject({ riff: "RIFF", kind: "WEBP" });
    await expect.poll(() => cachedPaths(page, "encoder")).toEqual([WASM, WORKER].sort());

    await context.setOffline(true);
    expect(await runWorker(page)).toMatchObject({ riff: "RIFF", kind: "WEBP" });
  });
});
