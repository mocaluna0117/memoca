import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NOTE_LIST, SIDEBAR, clampWidth, usePaneWidth } from "@/lib/hooks/use-pane-width";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let widths: number[];
let setWidth: (width: number | null) => void;

function Probe({ seen }: { seen: (width: number, set: (width: number | null) => void) => void }) {
  const [width, set] = usePaneWidth(SIDEBAR);
  seen(width, set);
  return null;
}

const render = () =>
  act(async () =>
    root.render(
      <Probe
        seen={(width, set) => {
          widths.push(width);
          setWidth = set;
        }}
      />,
    ),
  );
const last = () => widths.at(-1);

beforeEach(() => {
  localStorage.clear();
  widths = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("a pane's width", () => {
  test("starts as it is made, and is kept on this device once set", async () => {
    await render();
    expect(last()).toBe(SIDEBAR.initial);
    act(() => setWidth(300));
    expect(last()).toBe(300);
    expect(localStorage.getItem(SIDEBAR.key)).toBe("300");
    // Another pane keeps its own.
    expect(localStorage.getItem(NOTE_LIST.key)).toBeNull();
  });

  test("stays within what the pane allows, set or read back", async () => {
    await render();
    act(() => setWidth(10_000));
    expect(last()).toBe(SIDEBAR.max);
    act(() => setWidth(12.6));
    expect(last()).toBe(SIDEBAR.min);
    localStorage.setItem(SIDEBAR.key, "90");
    window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR.key }));
    await render();
    expect(last()).toBe(SIDEBAR.min);
    expect(clampWidth(SIDEBAR, 250.4)).toBe(250);
  });

  test("goes back to how it started, and anything not a width reads as that", async () => {
    await render();
    act(() => setWidth(300));
    act(() => setWidth(null));
    expect(last()).toBe(SIDEBAR.initial);
    expect(localStorage.getItem(SIDEBAR.key)).toBeNull();
    for (const junk of ["", "abc", "0", "NaN"]) {
      localStorage.setItem(SIDEBAR.key, junk);
      window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR.key }));
      await render();
      expect(last()).toBe(SIDEBAR.initial);
    }
  });

  test("set in another tab, it follows", async () => {
    await render();
    localStorage.setItem(SIDEBAR.key, "333");
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR.key })));
    expect(last()).toBe(333);
  });

  test("with storage refused, it starts as it is made and is not kept", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await render();
    expect(last()).toBe(SIDEBAR.initial);
    expect(() => act(() => setWidth(300))).not.toThrow();
    expect(last()).toBe(SIDEBAR.initial);
  });
});
