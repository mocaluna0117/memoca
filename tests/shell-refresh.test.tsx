import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SHELL_HIDDEN } from "@/lib/quick/shell";

const h = vi.hoisted(() => ({ newBuild: vi.fn(), flushed: vi.fn() }));
vi.mock("@/lib/build", () => ({ newBuildOut: h.newBuild }));
vi.mock("@/lib/sync/docs", () => ({ flushAll: h.flushed }));

import { HIDDEN_CHECK_MS, useShellRefresh } from "@/components/shell/shell-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Refreshed() {
  useShellRefresh();
  return null;
}

let root: Root;
let reload: ReturnType<typeof vi.fn>;
let focused: boolean;

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });

beforeEach(async () => {
  vi.useFakeTimers();
  h.newBuild.mockReset().mockResolvedValue(true);
  h.flushed.mockReset().mockResolvedValue(undefined);
  reload = vi.fn();
  focused = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Refreshed />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const putAway = async () => {
  await act(async () => {
    window.dispatchEvent(new Event(SHELL_HIDDEN));
  });
  await settle();
};

describe("Memoca's own window, kept hidden by the desktop shell", () => {
  test("put away with a new version out: saved, then loaded again", async () => {
    await putAway();
    expect(h.flushed).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  test("with none out, or out again by the time the server says: left as it is", async () => {
    h.newBuild.mockResolvedValue(false);
    await putAway();
    expect(reload).not.toHaveBeenCalled();

    h.newBuild.mockResolvedValue(true);
    focused = true;
    await putAway();
    expect(reload).not.toHaveBeenCalled();
  });

  test("hidden for an hour, it asks again; out, it does not", async () => {
    h.newBuild.mockResolvedValue(false);
    await putAway();
    h.newBuild.mockResolvedValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => vi.advanceTimersByTime(HIDDEN_CHECK_MS));
    await settle();
    expect(reload).not.toHaveBeenCalled();

    await putAway();
    reload.mockClear();
    h.newBuild.mockResolvedValue(false);
    await act(async () => vi.advanceTimersByTime(HIDDEN_CHECK_MS));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    h.newBuild.mockResolvedValue(true);
    await act(async () => vi.advanceTimersByTime(HIDDEN_CHECK_MS));
    await settle();
    expect(reload).toHaveBeenCalledOnce();
  });
});
