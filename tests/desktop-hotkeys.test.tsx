import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DesktopHotkeys } from "@/components/settings/desktop-hotkeys";
import { formatHotkey, hotkeyFromEvent, sameHotkey } from "@/lib/desktop/hotkeys";
import type { MemocaShell, ShellHotkeys } from "@/lib/quick/shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const keys = (code: string, held: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...held,
});

describe("a hotkey made from the keys pressed", () => {
  test("⌘ on a Mac, Ctrl on Windows, as CmdOrCtrl; the key by where it is", () => {
    expect(hotkeyFromEvent(keys("KeyM", { metaKey: true, shiftKey: true }), "macos")).toBe("CmdOrCtrl+Shift+M");
    expect(hotkeyFromEvent(keys("KeyM", { ctrlKey: true, shiftKey: true }), "windows")).toBe("CmdOrCtrl+Shift+M");
    expect(hotkeyFromEvent(keys("Space", { ctrlKey: true, altKey: true }), "macos")).toBe("Ctrl+Alt+Space");
    expect(hotkeyFromEvent(keys("Digit1", { metaKey: true }), "windows")).toBe("Super+1");
    expect(hotkeyFromEvent(keys("ArrowUp", { altKey: true }), "macos")).toBe("Alt+ArrowUp");
    expect(hotkeyFromEvent(keys("F13"), "macos")).toBe("F13");
  });

  test("a modifier alone is not one yet", () => {
    for (const code of ["ShiftLeft", "MetaRight", "ControlLeft", "AltRight", "OSLeft", "CapsLock", ""]) {
      expect(hotkeyFromEvent(keys(code, { metaKey: true }), "macos")).toBeNull();
    }
  });
});

describe("a hotkey as the computer marks it", () => {
  test("as written by the app, and by hand, in Tauri's other words for the same", () => {
    expect(formatHotkey("CmdOrCtrl+Shift+M", "macos")).toBe("⇧⌘M");
    expect(formatHotkey("CmdOrCtrl+Shift+M", "windows")).toBe("Ctrl+Shift+M");
    // The person's own file.
    expect(formatHotkey("CmdOrCtrl+M", "macos")).toBe("⌘M");
    expect(formatHotkey("CmdOrCtrl+K", "macos")).toBe("⌘K");
    expect(formatHotkey("CommandOrControl+Option+Space", "macos")).toBe("⌥⌘Space");
    expect(formatHotkey("ctrl+shift+space", "windows")).toBe("Ctrl+Shift+space");
    expect(formatHotkey("Alt+KeyN", "macos")).toBe("⌥N");
    expect(formatHotkey("Cmd+Digit2", "macos")).toBe("⌘2");
    expect(formatHotkey("Super+1", "windows")).toBe("Win+1");
    expect(formatHotkey("Ctrl+Alt+ArrowLeft", "macos")).toBe("⌃⌥←");
  });

  test("the same keys, however written", () => {
    expect(sameHotkey("CmdOrCtrl+Shift+M", "Shift+Cmd+KeyM", "macos")).toBe(true);
    expect(sameHotkey("CmdOrCtrl+Shift+M", "CmdOrCtrl+M", "macos")).toBe(false);
    // On Windows, CmdOrCtrl is Ctrl.
    expect(sameHotkey("CmdOrCtrl+K", "Ctrl+K", "windows")).toBe(true);
    expect(sameHotkey("CmdOrCtrl+K", "Ctrl+K", "macos")).toBe(false);
  });
});

describe("the desktop app's hotkeys, in the settings page", () => {
  let root: Root;
  let host: HTMLDivElement;
  let kept: ShellHotkeys;
  let calls: string[];
  let refuse: string | null;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    kept = { quick: "CmdOrCtrl+M", app: "CmdOrCtrl+K", quickDefault: "CmdOrCtrl+Shift+M", appDefault: "CmdOrCtrl+Shift+M" };
    calls = [];
    refuse = null;
    window.memocaShell = {
      platform: "macos",
      hotkeys: {
        get: vi.fn(async () => kept),
        set: vi.fn(async (which: "quick" | "app", keys: string) => {
          calls.push(`set ${which} ${keys}`);
          if (refuse) throw refuse;
          kept = { ...kept, [which]: keys };
          return kept;
        }),
        recording: vi.fn(async (on: boolean) => {
          calls.push(`recording ${on}`);
        }),
      },
    } as unknown as MemocaShell;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.memocaShell;
  });

  const button = (name: string, nth = 0) =>
    [...document.querySelectorAll("button")].filter((each) => each.textContent === name)[nth]!;
  const shown = () => [...document.querySelectorAll("kbd")].map((each) => each.textContent);
  const press = (code: string, key: string, held: Partial<KeyboardEventInit> = {}) =>
    act(async () => {
      const event = new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...held });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

  test("the keys pressed are the quick note's at once, the app's hotkeys let go of while they are pressed", async () => {
    await act(async () => root.render(<DesktopHotkeys />));
    expect(shown()).toEqual(["⌘M", "⌘K"]);

    await act(async () => button("変更", 0).click());
    expect(document.body.textContent).toContain("キーを押してください");
    // A modifier alone: still listening.
    await press("ShiftLeft", "Shift", { shiftKey: true, metaKey: true });
    await press("KeyJ", "j", { metaKey: true, shiftKey: true });
    expect(calls).toEqual(["recording true", "recording false", "set quick CmdOrCtrl+Shift+J"]);
    expect(shown()).toEqual(["⇧⌘J", "⌘K"]);
  });

  test("turned away: said why, and left as it was", async () => {
    refuse = "taken";
    await act(async () => root.render(<DesktopHotkeys />));
    await act(async () => button("変更", 1).click());
    await press("KeyL", "l", { metaKey: true });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("ほかのアプリが使っているキー");
    expect(shown()).toEqual(["⌘M", "⌘K"]);
  });

  test("Esc stops, the app's hotkeys back, nothing changed", async () => {
    await act(async () => root.render(<DesktopHotkeys />));
    await act(async () => button("変更", 0).click());
    await press("Escape", "Escape");
    expect(calls).toEqual(["recording true", "recording false"]);
    expect(shown()).toEqual(["⌘M", "⌘K"]);
  });

  test("back to what it was: the default", async () => {
    await act(async () => root.render(<DesktopHotkeys />));
    await act(async () => button("元に戻す", 0).click());
    expect(calls).toEqual(["set quick CmdOrCtrl+Shift+M"]);
    expect(shown()[0]).toBe("⇧⌘M");
  });

  test("Memoca's own on the quick note's keys, as both start: said to be the quick note's", async () => {
    kept = { ...kept, quick: "CmdOrCtrl+Shift+M", app: "CmdOrCtrl+Shift+M" };
    await act(async () => root.render(<DesktopHotkeys />));
    expect(document.body.textContent).toContain("今は即席メモが使います");
    // At their defaults: nothing to put back.
    expect([...document.querySelectorAll("button")].some((each) => each.textContent === "元に戻す")).toBe(false);
  });

  test("an app from before 0.4.11: where to change them meanwhile", async () => {
    window.memocaShell = { platform: "macos" } as unknown as MemocaShell;
    await act(async () => root.render(<DesktopHotkeys />));
    expect(document.body.textContent).toContain("設定ファイルを開く");
  });

  test("in a browser: nothing", async () => {
    delete window.memocaShell;
    await act(async () => root.render(<DesktopHotkeys />));
    expect(host.textContent).toBe("");
  });
});
