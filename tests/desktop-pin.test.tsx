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
  let calls: boolean[];
  let refuse: boolean;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    kept = false;
    calls = [];
    refuse = false;
    window.memocaShell = {
      platform: "macos",
      pinned: {
        get: vi.fn(async () => kept),
        set: vi.fn(async (on: boolean) => {
          calls.push(on);
          if (refuse) throw new Error("no");
          kept = on;
          return kept;
        }),
      },
    } as unknown as MemocaShell;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.memocaShell;
  });

  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]');
  const checked = () => toggle()?.getAttribute("aria-checked");

  test("shown as the app has it, and changed there", async () => {
    kept = true;
    await act(async () => root.render(<DesktopPin />));
    expect(checked()).toBe("true");

    await act(async () => toggle()!.click());
    expect(calls).toEqual([false]);
    expect(checked()).toBe("false");
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
    expect(calls).toEqual([true]);
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
