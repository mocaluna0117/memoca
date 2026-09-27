import { afterEach, describe, expect, test, vi } from "vitest";
import { type MemocaShell, closeQuickWindow, inShell, openInApp } from "@/lib/quick/shell";

const shell = (): MemocaShell => ({ hide: vi.fn(), openExternal: vi.fn(), platform: "macos" });

/** A window as these helpers see it: what it holds, and what was asked of it. */
function windowWith(over: Partial<Window> = {}) {
  return {
    close: vi.fn(),
    opener: null,
    location: { origin: "https://memoca-app.vercel.app", assign: vi.fn() },
    ...over,
  } as unknown as Window & {
    close: ReturnType<typeof vi.fn>;
    location: { assign: ReturnType<typeof vi.fn> };
  };
}

afterEach(() => {
  delete window.memocaShell;
  vi.restoreAllMocks();
});

describe("inShell", () => {
  test("is known by the shell's object, or by its user agent before the page's script runs", () => {
    expect(inShell()).toBe(false);
    window.memocaShell = shell();
    expect(inShell()).toBe(true);
    delete window.memocaShell;
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh) MemocaShell/0.1.0 (macos)",
    );
    expect(inShell()).toBe(true);
  });
});

describe("closeQuickWindow", () => {
  test("hides the shell's window rather than closing it", () => {
    const here = windowWith({ memocaShell: shell() });
    closeQuickWindow(here);
    expect(here.memocaShell!.hide).toHaveBeenCalledOnce();
    expect(here.close).not.toHaveBeenCalled();
  });

  test("closes a window of the browser's", () => {
    const here = windowWith();
    closeQuickWindow(here);
    expect(here.close).toHaveBeenCalledOnce();
  });
});

describe("openInApp", () => {
  test("from the shell, opens the page in the default browser, in full", () => {
    const here = windowWith({ memocaShell: shell() });
    openInApp("/app?n=abc", here);
    expect(here.memocaShell!.openExternal).toHaveBeenCalledWith(
      "https://memoca-app.vercel.app/app?n=abc",
    );
    expect(here.location.assign).not.toHaveBeenCalled();
  });

  test("from a window the app opened, opens it there, and brings that window forward", () => {
    const opener = { closed: false, focus: vi.fn(), location: { assign: vi.fn() } };
    const here = windowWith({ opener: opener as unknown as Window });
    openInApp("/app?n=abc", here);
    expect(opener.location.assign).toHaveBeenCalledWith("/app?n=abc");
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(here.location.assign).not.toHaveBeenCalled();
  });

  test("with no window to open it in, or one that is closed or not ours, opens it here", () => {
    const alone = windowWith();
    openInApp("/app?n=abc", alone);
    expect(alone.location.assign).toHaveBeenCalledWith("/app?n=abc");

    const gone = { closed: true, focus: vi.fn(), location: { assign: vi.fn() } };
    const closed = windowWith({ opener: gone as unknown as Window });
    openInApp("/app?n=abc", closed);
    expect(gone.location.assign).not.toHaveBeenCalled();
    expect(closed.location.assign).toHaveBeenCalledWith("/app?n=abc");

    const foreign = {
      closed: false,
      focus: vi.fn(),
      location: {
        assign: () => {
          throw new DOMException("Blocked a frame with origin", "SecurityError");
        },
      },
    };
    const elsewhere = windowWith({ opener: foreign as unknown as Window });
    openInApp("/app?n=abc", elsewhere);
    expect(elsewhere.location.assign).toHaveBeenCalledWith("/app?n=abc");
  });
});
