import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { escapeHidesWindow, useEscapeHidesWindow } from "@/lib/desktop/escape-hides-window";
import type { MemocaShell } from "@/lib/quick/shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const esc = (init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });

describe("an Esc that puts Memoca's own window away", () => {
  test("one nothing else took", () => {
    expect(escapeHidesWindow(esc())).toBe(true);
  });

  test("not another key, one held down, one with a modifier, nor an input method's", () => {
    expect(escapeHidesWindow(esc({ key: "Enter" }))).toBe(false);
    expect(escapeHidesWindow(esc({ repeat: true }))).toBe(false);
    expect(escapeHidesWindow(esc({ shiftKey: true }))).toBe(false);
    expect(escapeHidesWindow(esc({ metaKey: true }))).toBe(false);
    expect(escapeHidesWindow(esc({ isComposing: true }))).toBe(false);
    expect(escapeHidesWindow(esc({ keyCode: 229 }))).toBe(false);
  });

  test("not one taken already, nor with a layer open", () => {
    const taken = esc();
    taken.preventDefault();
    expect(escapeHidesWindow(taken)).toBe(false);

    const layer = document.createElement("div");
    layer.setAttribute("role", "dialog");
    layer.dataset.state = "open";
    document.body.append(layer);
    expect(escapeHidesWindow(esc())).toBe(false);
    layer.remove();
  });
});

function Shell() {
  useEscapeHidesWindow();
  return <input aria-label="field" />;
}

describe("Esc in the desktop app's window for the whole of Memoca", () => {
  let root: Root;
  let host: HTMLDivElement;
  let hideWindow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    hideWindow = vi.fn();
    window.memocaShell = { platform: "macos", hide: vi.fn(), hideWindow } as unknown as MemocaShell;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.memocaShell;
  });

  test("puts it away, from the page or a field", async () => {
    await act(async () => root.render(<Shell />));
    const event = esc();
    document.body.dispatchEvent(event);
    expect(hideWindow).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    host.querySelector("input")!.dispatchEvent(esc());
    expect(hideWindow).toHaveBeenCalledTimes(2);
  });

  test("not one the page took first", async () => {
    await act(async () => root.render(<Shell />));
    const take = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", take);
    document.body.dispatchEvent(esc());
    document.removeEventListener("keydown", take);
    expect(hideWindow).not.toHaveBeenCalled();
  });

  test("nothing from an app before 0.4.17, whose hide is the quick note's", async () => {
    window.memocaShell = { platform: "macos", hide: vi.fn() } as unknown as MemocaShell;
    await act(async () => root.render(<Shell />));
    document.body.dispatchEvent(esc());
    expect(window.memocaShell.hide).not.toHaveBeenCalled();
  });
});
