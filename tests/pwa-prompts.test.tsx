import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
  flushAll: vi.fn(async () => undefined),
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/lib/sync/docs", () => ({ flushAll: h.flushAll }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A service worker of this build, as it answers a page asking which it is. The page's is "dev". */
const worker = (build: string) => ({
  postMessage: (_message: unknown, [port]: MessagePort[]) => port!.postMessage(build),
});

let PwaPrompts: typeof import("@/components/shell/pwa-prompts").PwaPrompts;
let UPDATE_CHECK_MS: number;
let workers: EventTarget & { controller: object | null; getRegistration: () => Promise<unknown> };
let update: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

/** Opens a page of the app under `controller` (null on a first visit). */
async function open(controller: object | null) {
  update = vi.fn(async () => undefined);
  const registration = Object.assign(new EventTarget(), { waiting: null, update });
  workers = Object.assign(new EventTarget(), {
    controller,
    getRegistration: async () => registration,
  });
  Object.defineProperty(navigator, "serviceWorker", { value: workers, configurable: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<PwaPrompts />));
}

/** Another worker takes the page over, and answers which build it is. */
async function takeOver(by: object) {
  await act(async () => {
    workers.controller = by;
    workers.dispatchEvent(new Event("controllerchange"));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(async () => {
  // The module remembers a page was found out of date: fresh for each test.
  vi.resetModules();
  ({ PwaPrompts, UPDATE_CHECK_MS } = await import("@/components/shell/pwa-prompts"));
  h.toast.mockReset();
  h.toast.dismiss.mockReset();
  h.flushAll.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setVisibility("visible");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a new version of the app", () => {
  test("of another build taking a page over is offered to it, as one toast that stays", async () => {
    await open(worker("dev-old"));
    await takeOver(worker("next"));
    await takeOver(worker("next"));
    expect(h.toast).toHaveBeenCalled();
    for (const [message, options] of h.toast.mock.calls) {
      expect(message).toBe("新しいバージョンがあります");
      expect(options).toMatchObject({ id: "new-version", duration: Number.POSITIVE_INFINITY });
      expect(options.action.label).toBe("更新");
    }
  });

  test("of this page's own build is nothing to offer: a first visit's, or one found as a new page came", async () => {
    await open(null);
    await takeOver(worker("dev"));
    await act(async () => root.unmount());
    await open(worker("dev-old"));
    await takeOver(worker("dev"));
    expect(h.toast).not.toHaveBeenCalled();
  });

  test("a first visit's page left open across a deploy is offered the next", async () => {
    await open(null);
    await takeOver(worker("dev"));
    await takeOver(worker("next"));
    expect(h.toast).toHaveBeenCalledOnce();
  });

  test("更新 stores what was just typed, then loads the page again", async () => {
    await open(worker("dev-old"));
    await takeOver(worker("next"));
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await act(async () => h.toast.mock.calls[0]![1].action.onClick());
    expect(h.flushAll).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  test("is not carried over to the quick note, and is offered again on coming back", async () => {
    await open(worker("dev-old"));
    await takeOver(worker("next"));
    await act(async () => root.unmount());
    expect(h.toast.dismiss).toHaveBeenCalledWith("new-version");
    h.toast.mockClear();
    await open(worker("next"));
    expect(h.toast).toHaveBeenCalledOnce();
  });

  test("is looked for every so often while in sight, on coming back into sight after that long, and on the network's return", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await open(worker("dev"));
    await act(async () => vi.advanceTimersByTime(UPDATE_CHECK_MS - 1));
    expect(update).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(update).toHaveBeenCalledOnce();

    setVisibility("hidden");
    await act(async () => vi.advanceTimersByTime(UPDATE_CHECK_MS * 2));
    expect(update).toHaveBeenCalledOnce();
    await act(async () => setVisibility("visible"));
    expect(update).toHaveBeenCalledTimes(2);
    // Straight back into sight: not asked again so soon.
    await act(async () => setVisibility("visible"));
    expect(update).toHaveBeenCalledTimes(2);

    await act(async () => window.dispatchEvent(new Event("online")));
    expect(update).toHaveBeenCalledTimes(3);

    // And no more once the page has gone.
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTime(UPDATE_CHECK_MS * 2));
    expect(update).toHaveBeenCalledTimes(3);
    root = createRoot(host);
  });
});
