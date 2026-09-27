import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type MemocaShell,
  OPEN_NOTE,
  closeQuickWindow,
  inShell,
  openNoteInApp,
} from "@/lib/quick/shell";

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
    open: ReturnType<typeof vi.fn>;
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

describe("openNoteInApp", () => {
  const path = "/app?n=abc";

  /** A window of the app's that opened this one, showing `pathname`. */
  function openerAt(pathname: string, over: Record<string, unknown> = {}) {
    return {
      closed: false,
      focus: vi.fn(),
      postMessage: vi.fn(),
      location: { pathname, assign: vi.fn() },
      ...over,
    };
  }

  test("from the shell, opens the note in the default browser, in full", () => {
    const here = windowWith({ memocaShell: shell(), open: vi.fn() });
    openNoteInApp("abc", here);
    expect(here.memocaShell!.openExternal).toHaveBeenCalledWith(
      "https://memoca-app.vercel.app/app?n=abc",
    );
    expect(here.open).not.toHaveBeenCalled();
    expect(here.location.assign).not.toHaveBeenCalled();
  });

  test("from a window the app opened, tells the app there to move to it, and brings it forward", () => {
    const opener = openerAt("/app");
    const here = windowWith({ opener: opener as unknown as Window, open: vi.fn() });
    openNoteInApp("abc", here);
    // Told, not loaded again: a reload would lock its vault.
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: OPEN_NOTE, noteId: "abc" },
      "https://memoca-app.vercel.app",
    );
    expect(opener.location.assign).not.toHaveBeenCalled();
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(here.open).not.toHaveBeenCalled();
    expect(here.location.assign).not.toHaveBeenCalled();
  });

  test("a window that opened this one and has since left the app is loaded with the note", () => {
    const opener = openerAt("/settings");
    const here = windowWith({ opener: opener as unknown as Window, open: vi.fn() });
    openNoteInApp("abc", here);
    expect(opener.location.assign).toHaveBeenCalledWith(path);
    expect(opener.postMessage).not.toHaveBeenCalled();
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(here.open).not.toHaveBeenCalled();
  });

  test("with no window of the app's at hand, opens a new one, and this one stays the quick note", () => {
    const alone = windowWith({ open: vi.fn(() => ({}) as Window) });
    openNoteInApp("abc", alone);
    expect(alone.open).toHaveBeenCalledWith(path, "_blank");
    expect(alone.location.assign).not.toHaveBeenCalled();

    const gone = openerAt("/app", { closed: true });
    const closed = windowWith({
      opener: gone as unknown as Window,
      open: vi.fn(() => ({}) as Window),
    });
    openNoteInApp("abc", closed);
    expect(gone.postMessage).not.toHaveBeenCalled();
    expect(gone.location.assign).not.toHaveBeenCalled();
    expect(closed.open).toHaveBeenCalledWith(path, "_blank");

    // Another site's window: reading where it is throws, and it is left alone.
    const foreign = {
      closed: false,
      focus: vi.fn(),
      postMessage: vi.fn(),
      get location(): never {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    };
    const elsewhere = windowWith({
      opener: foreign as unknown as Window,
      open: vi.fn(() => ({}) as Window),
    });
    openNoteInApp("abc", elsewhere);
    expect(foreign.postMessage).not.toHaveBeenCalled();
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(elsewhere.open).toHaveBeenCalledWith(path, "_blank");
  });

  test("a new window the browser will not open: the note opens here instead", () => {
    const blocked = windowWith({ open: vi.fn(() => null) });
    openNoteInApp("abc", blocked);
    expect(blocked.open).toHaveBeenCalledOnce();
    expect(blocked.location.assign).toHaveBeenCalledWith(path);
  });
});
