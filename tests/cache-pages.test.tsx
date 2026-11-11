import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ pathname: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));

import { CachePages, resetAskedPages } from "@/components/providers/cache-pages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const posted = vi.fn();

beforeEach(() => {
  resetAskedPages();
  posted.mockReset();
  h.pathname = "/app";
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { controller: { postMessage: posted } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const asked = () => posted.mock.calls.map(([message]) => (message as { payload: { urlsToCache: string[] } }).payload.urlsToCache);

describe("the pages the worker is asked to keep a copy of, for offline", () => {
  test("a page moved to within the app, once; the page loaded, and a move between notes (its query), not at all", async () => {
    await act(async () => root.render(<CachePages />));
    // Loaded as a page: the worker kept it as it went by.
    expect(posted).not.toHaveBeenCalled();

    h.pathname = "/quick";
    await act(async () => root.render(<CachePages />));
    h.pathname = "/app/settings";
    await act(async () => root.render(<CachePages />));
    h.pathname = "/quick";
    await act(async () => root.render(<CachePages />));
    h.pathname = "/app";
    await act(async () => root.render(<CachePages />));
    expect(asked()).toEqual([["/quick"], ["/app/settings"], ["/app"]]);
    // No reply asked for: no channel left waiting for one.
    expect(posted.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  test("the page shown, again as the network comes back", async () => {
    await act(async () => root.render(<CachePages />));
    window.dispatchEvent(new Event("online"));
    expect(asked()).toEqual([[window.location.pathname]]);
  });

  test("with no worker in control, nothing", async () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: null } });
    await act(async () => root.render(<CachePages />));
    h.pathname = "/quick";
    await act(async () => root.render(<CachePages />));
    expect(posted).not.toHaveBeenCalled();
  });
});
