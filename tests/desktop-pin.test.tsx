import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DesktopPin } from "@/components/settings/desktop-pin";
import type { MemocaShell } from "@/lib/quick/shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the desktop app's ピン留め, in the settings page", () => {
  let root: Root;
  let host: HTMLDivElement;
  let kept: boolean;
  let keptApp: boolean;
  let calls: string[];
  let refuse: boolean;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    kept = false;
    keptApp = true;
    calls = [];
    refuse = false;
    window.memocaShell = {
      platform: "macos",
      pinned: {
        get: vi.fn(async () => kept),
        set: vi.fn(async (on: boolean) => {
          calls.push(`quick ${on}`);
          if (refuse) throw new Error("no");
          kept = on;
          return kept;
        }),
      },
      appPinned: {
        get: vi.fn(async () => keptApp),
        set: vi.fn(async (on: boolean) => {
          calls.push(`app ${on}`);
          keptApp = on;
          return keptApp;
        }),
      },
      letGoWhenShort: {
        get: vi.fn(async () => true),
        set: vi.fn(async (on: boolean) => {
          calls.push(`let go ${on}`);
          return on;
        }),
      },
    } as unknown as MemocaShell;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.memocaShell;
  });

  const toggle = (id = "desktop-pin-quick") => document.querySelector<HTMLButtonElement>(`#${id}`);
  const checked = (id?: string) => toggle(id)?.getAttribute("aria-checked");

  test("shown as the app has it, and changed there", async () => {
    kept = true;
    await act(async () => root.render(<DesktopPin />));
    expect(checked()).toBe("true");

    await act(async () => toggle()!.click());
    expect(calls).toEqual(["quick false"]);
    expect(checked()).toBe("false");
  });

  test("Memoca's own window has one of its own", async () => {
    await act(async () => root.render(<DesktopPin />));
    expect(checked("desktop-pin-app")).toBe("true");
    await act(async () => toggle("desktop-pin-app")!.click());
    expect(calls).toEqual(["app false"]);
    expect(checked("desktop-pin-app")).toBe("false");
    expect(checked()).toBe("false");
  });

  test("an app of 0.4.18: Memoca's own window hidden, left behind, or on top", async () => {
    let above = false;
    (window.memocaShell as { appOnTop?: unknown }).appOnTop = {
      get: vi.fn(async () => above),
      set: vi.fn(async (on: boolean) => {
        calls.push(`on top ${on}`);
        above = on;
        return above;
      }),
    };
    // What Radix's Select asks of the page, which jsdom has not.
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    await act(async () => root.render(<DesktopPin />));
    const trigger = document.querySelector<HTMLButtonElement>("#desktop-app-window")!;
    expect(trigger.textContent).toBe("後ろに回る（ふつうのウィンドウ）");
    expect(toggle("desktop-pin-app")).toBeNull();

    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (each) => each.textContent === "最前面に固定（ピン留め）",
    )!;
    await act(async () => {
      option.focus();
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(calls).toEqual(["on top true", "app true"]);
    expect(document.querySelector("#desktop-app-window")!.textContent).toBe("最前面に固定（ピン留め）");
  });

  test("on a Mac, whether Memoca's own window is let go of while memory is short", async () => {
    await act(async () => root.render(<DesktopPin />));
    expect(checked("desktop-let-go")).toBe("true");
    await act(async () => toggle("desktop-let-go")!.click());
    expect(calls).toEqual(["let go false"]);
    expect(checked("desktop-let-go")).toBe("false");
  });

  test("not on Windows, which keeps the window as it is", async () => {
    (window.memocaShell as { platform: string }).platform = "windows";
    await act(async () => root.render(<DesktopPin />));
    expect(toggle("desktop-pin-app")).not.toBeNull();
    expect(toggle("desktop-let-go")).toBeNull();
  });

  test("an app of 0.4.16: the quick note's alone, Memoca's own once it is updated", async () => {
    delete (window.memocaShell as { appPinned?: unknown }).appPinned;
    await act(async () => root.render(<DesktopPin />));
    expect(toggle()).not.toBeNull();
    expect(toggle("desktop-pin-app")).toBeNull();
    expect(document.body.textContent).toContain("Memoca のウィンドウの出し方は、アプリが新しい版に更新されると");
  });

  test("read again as the window comes to the front: changed from the menu meanwhile", async () => {
    await act(async () => root.render(<DesktopPin />));
    expect(checked()).toBe("false");
    kept = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(checked()).toBe("true");
  });

  test("turned away: back as it was", async () => {
    refuse = true;
    await act(async () => root.render(<DesktopPin />));
    await act(async () => toggle()!.click());
    expect(calls).toEqual(["quick true"]);
    expect(checked()).toBe("false");
  });

  test("an app before 0.4.16: the menu's, until it is updated", async () => {
    window.memocaShell = { platform: "windows" } as unknown as MemocaShell;
    await act(async () => root.render(<DesktopPin />));
    expect(toggle()).toBeNull();
    expect(document.body.textContent).toContain("タスクバーの ⚡ アイコンのメニューの「ピン留め」");
  });

  test("nothing in a browser", async () => {
    delete window.memocaShell;
    await act(async () => root.render(<DesktopPin />));
    expect(host.textContent).toBe("");
  });
});
