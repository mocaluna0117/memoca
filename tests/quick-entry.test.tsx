import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ openNote: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/hooks/workspace", () => ({ useWorkspace: () => ({ openNote: h.openNote }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));

import { OpenNoteFromQuickWindow, QuickNoteShortcut } from "@/components/notes/quick-entry";
import { OPENED_NOTE, OPEN_NOTE } from "@/lib/quick/shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  h.openNote.mockReset();
  h.push.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the app's window, asked by the quick note's to open a note", () => {
  const ask = (data: unknown, origin = window.location.origin) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: window }));
    });

  test("moves to it within the app, and answers", async () => {
    await act(async () => root.render(<OpenNoteFromQuickWindow />));
    const answered = vi.spyOn(window, "postMessage");
    await ask({ type: OPEN_NOTE, noteId: "n1" });
    expect(h.openNote).toHaveBeenCalledWith("n1");
    expect(answered).toHaveBeenCalledWith(
      { type: OPENED_NOTE, noteId: "n1" },
      window.location.origin,
    );
  });

  test("heeds nothing from another site, nor anything else", async () => {
    await act(async () => root.render(<OpenNoteFromQuickWindow />));
    await ask({ type: OPEN_NOTE, noteId: "n1" }, "https://evil.example");
    await ask({ type: OPEN_NOTE, noteId: 7 });
    await ask({ type: "other", noteId: "n1" });
    await ask(null);
    expect(h.openNote).not.toHaveBeenCalled();
  });
});

describe("Q, for the quick note", () => {
  let opened: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // A computer's width: the quick note gets a window of its own.
    vi.stubGlobal("matchMedia", () => ({ matches: true }) as MediaQueryList);
    opened = vi.fn(() => ({ location: { pathname: "/quick" }, focus: vi.fn() }));
    vi.spyOn(window, "open").mockImplementation(opened as unknown as typeof window.open);
    await act(async () => root.render(<QuickNoteShortcut />));
  });

  const press = (init: KeyboardEventInit = {}, target: EventTarget = document.body) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true, ...init }),
      );
    });

  test("opens it from anywhere in the app", async () => {
    await press();
    expect(opened).toHaveBeenCalledOnce();
  });

  test("but not while something is being typed, or a key held, or a word being chosen", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    await press({}, field);
    await press({ repeat: true });
    await press({ isComposing: true });
    await press({ metaKey: true });
    expect(opened).not.toHaveBeenCalled();
  });

  test("nor while a dialog or a menu is open", async () => {
    for (const role of ["dialog", "alertdialog", "menu"]) {
      const open = document.createElement("div");
      open.setAttribute("role", role);
      open.dataset.state = "open";
      document.body.append(open);
      await press();
      open.remove();
    }
    expect(opened).not.toHaveBeenCalled();
    // One on its way out after closing counts for nothing.
    const closing = document.createElement("div");
    closing.setAttribute("role", "menu");
    closing.dataset.state = "closed";
    document.body.append(closing);
    await press();
    expect(opened).toHaveBeenCalledOnce();
  });
});
