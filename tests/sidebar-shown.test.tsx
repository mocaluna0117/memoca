import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SIDEBAR_SHOWN_KEY, isSidebarKey, useSidebarShown } from "@/lib/hooks/use-sidebar-shown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let seen: boolean[];
let setShown: (shown: boolean) => void;

function Probe({ found }: { found: (shown: boolean, set: (shown: boolean) => void) => void }) {
  const [shown, set] = useSidebarShown();
  found(shown, set);
  return null;
}

const render = () =>
  act(async () =>
    root.render(
      <Probe
        found={(shown, set) => {
          seen.push(shown);
          setShown = set;
        }}
      />,
    ),
  );

beforeEach(() => {
  localStorage.clear();
  seen = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the sidebar put away", () => {
  test("is shown until it is put away, and kept away on this device", async () => {
    await render();
    expect(seen.at(-1)).toBe(true);
    await act(async () => setShown(false));
    expect(seen.at(-1)).toBe(false);
    expect(localStorage.getItem(SIDEBAR_SHOWN_KEY)).toBe("hidden");

    // As the next page this device opens finds it.
    act(() => root.unmount());
    root = createRoot(host);
    seen = [];
    await render();
    expect(seen.at(-1)).toBe(false);
  });

  test("brought back, leaves nothing kept", async () => {
    localStorage.setItem(SIDEBAR_SHOWN_KEY, "hidden");
    await render();
    expect(seen.at(-1)).toBe(false);
    await act(async () => setShown(true));
    expect(seen.at(-1)).toBe(true);
    expect(localStorage.getItem(SIDEBAR_SHOWN_KEY)).toBeNull();
  });
});

describe("the key that puts it away or brings it back", () => {
  const press = (init: KeyboardEventInit) => isSidebarKey(new KeyboardEvent("keydown", init));

  test("is ⌘\\ or Ctrl+\\, the ¥ key on a Japanese keyboard among them", () => {
    expect(press({ key: "\\", code: "Backslash", metaKey: true })).toBe(true);
    expect(press({ key: "\\", code: "Backslash", ctrlKey: true })).toBe(true);
    expect(press({ key: "¥", code: "IntlYen", metaKey: true })).toBe(true);
  });

  test("is no other, nor any while a word is being written", () => {
    expect(press({ key: "\\", code: "Backslash" })).toBe(false);
    expect(press({ key: "\\", code: "Backslash", metaKey: true, shiftKey: true })).toBe(false);
    expect(press({ key: "\\", code: "Backslash", metaKey: true, altKey: true })).toBe(false);
    expect(press({ key: "b", code: "KeyB", metaKey: true })).toBe(false);
    expect(press({ key: "\\", code: "Backslash", metaKey: true, isComposing: true })).toBe(false);
  });
});
