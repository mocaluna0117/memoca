import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DETAILS_AFTER_MS, showExportCover } from "@/lib/export/export-cover";

describe("the cover a PDF is made under", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  const cover = () => document.querySelector<HTMLElement>(".memoca-export-cover");
  const line = () => cover()!.querySelector("p[aria-hidden]")!;
  const bar = () => cover()!.querySelector<HTMLElement>("[role=progressbar]")!;
  const status = () => cover()!.querySelector("[role=status]")!;
  const button = () => cover()!.querySelector("button")!;
  const hidden = (element: Element) => !!element.closest(".invisible, [hidden]");

  test("says what it is doing at once; the percent, the bar and the button come once it has gone on a while", () => {
    showExportCover({ onCancel: () => {} });
    expect(line().textContent).toBe("PDF を書き出しています… 0%");
    expect(hidden(line().querySelector("span")!)).toBe(true);
    expect(hidden(bar())).toBe(true);
    expect(hidden(button())).toBe(true);

    vi.advanceTimersByTime(DETAILS_AFTER_MS - 1);
    expect(hidden(bar())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hidden(line().querySelector("span")!)).toBe(false);
    expect(hidden(bar())).toBe(false);
    expect(hidden(button())).toBe(false);
    expect(button().textContent).toBe("キャンセル");
    // The keyboard can cancel at once.
    expect(document.activeElement).toBe(button());
  });

  test("shows how far it has come: the number, the bar's width, and its value as a screen reader has it", () => {
    const shown = showExportCover({ onCancel: () => {} });
    shown.set(42);
    expect(line().textContent).toBe("PDF を書き出しています… 42%");
    expect(bar().getAttribute("aria-valuenow")).toBe("42");
    expect(bar().getAttribute("aria-valuetext")).toBe("42%");
    expect(bar().getAttribute("aria-valuemin")).toBe("0");
    expect(bar().getAttribute("aria-valuemax")).toBe("100");
    expect(bar().getAttribute("aria-label")).toBe("PDF の書き出し");
    expect((bar().firstElementChild as HTMLElement).style.width).toBe("42%");
    shown.set(100);
    expect(line().textContent).toBe("PDF を書き出しています… 100%");
  });

  test("reads out that it has begun, then each quarter of the way, not every percent", () => {
    const shown = showExportCover({ onCancel: () => {} });
    expect(status().getAttribute("aria-live")).toBe("polite");
    expect(status().textContent).toBe("PDF を書き出しています…");
    shown.set(10);
    shown.set(24);
    expect(status().textContent).toBe("PDF を書き出しています…");
    shown.set(30);
    expect(status().textContent).toBe("PDF を書き出しています… 25%");
    shown.set(49);
    expect(status().textContent).toBe("PDF を書き出しています… 25%");
    // Past two at once: the latest only.
    shown.set(80);
    expect(status().textContent).toBe("PDF を書き出しています… 75%");
    // What is seen changing is not read out: only the status is live.
    expect(cover()!.querySelectorAll("[aria-live], [role=status], [role=alert]")).toHaveLength(1);
  });

  test("cancels once, from its button, and says it is stopping meanwhile", () => {
    const onCancel = vi.fn();
    showExportCover({ onCancel });
    vi.advanceTimersByTime(DETAILS_AFTER_MS);
    button().click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("中止しています…");
    expect(status().textContent).toBe("中止しています…");
    button().click();
    cover()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("is a dialog over everything, which Tab does not leave for the note beneath", () => {
    showExportCover({ onCancel: () => {} });
    vi.advanceTimersByTime(DETAILS_AFTER_MS);
    expect(cover()!.getAttribute("role")).toBe("dialog");
    expect(cover()!.getAttribute("aria-modal")).toBe("true");
    expect(cover()!.getAttribute("aria-label")).toBe("PDF の書き出し");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    button().dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
  });

  test("cancels with Escape too, which goes no further", () => {
    const onCancel = vi.fn();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    showExportCover({ onCancel });
    vi.advanceTimersByTime(DETAILS_AFTER_MS);
    button().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outside);
  });

  test("made quickly, it goes with only what it was doing shown, and leaves nothing behind", () => {
    const shown = showExportCover({ onCancel: () => {} });
    shown.set(60);
    shown.set(100);
    shown.remove();
    expect(cover()).toBeNull();
    vi.advanceTimersByTime(DETAILS_AFTER_MS * 2);
    expect(document.activeElement).toBe(document.body);
  });

  test("takes the focus from what is under it, as the menu it was chosen from may have it still", () => {
    const menu = document.createElement("div");
    menu.tabIndex = -1;
    document.body.append(menu);
    menu.focus();
    showExportCover({ onCancel: () => {} });
    vi.advanceTimersByTime(DETAILS_AFTER_MS);
    expect(document.activeElement).toBe(button());
  });
});
