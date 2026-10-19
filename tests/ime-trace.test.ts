import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startImeTrace, traceIme } from "@/lib/debug/ime-trace";

/** The desktop shell's window on a Mac: the shell by its user agent, and Apple's keys. */
const SHELL_MAC = "Mozilla/5.0 (Macintosh) MemocaShell/0.1.0 (macos)";
/** Safari on a Mac, no shell. */
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

/** The key that starts the record, and copies it. */
const TOGGLE = { metaKey: true, altKey: true, shiftKey: true, code: "KeyI", bubbles: true };

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let onStarted: ReturnType<typeof vi.fn<() => void>>;
let onCopied: ReturnType<typeof vi.fn<() => void>>;
let stop: (() => void) | null = null;
/** A plain field with the focus, as the quick note's. */
let field: HTMLTextAreaElement;

/** The event types a spy on add/removeEventListener saw, in order. */
const typesSeen = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call[0]);

const start = () => {
  stop = startImeTrace({ onStarted, onCopied });
};
const toggle = () => window.dispatchEvent(new KeyboardEvent("keydown", TOGGLE));
const typeKey = () =>
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
/** What the last ⌘⌥⇧I put on the clipboard, once it is there. */
const copied = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  return writeText.mock.lastCall?.[0] as string;
};
/** Its entries, the user agent's line left out. */
const entriesCopied = async () =>
  (await copied())
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(SHELL_MAC);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  onStarted = vi.fn();
  onCopied = vi.fn();
  field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
});

afterEach(() => {
  stop?.();
  stop = null;
  field.remove();
  localStorage.removeItem("memoca:ime-trace");
  vi.restoreAllMocks();
});

describe("the input record, in the Mac desktop app", () => {
  test("until it is asked for, listens for nothing but ⌘⌥⇧I, and keeps nothing", async () => {
    const added = vi.spyOn(document, "addEventListener");
    const observed = vi.spyOn(MutationObserver.prototype, "observe");
    start();
    expect(added).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
    typeKey();
    traceIme({ type: "ime:idle" });
    toggle();
    toggle();
    const text = await copied();
    expect(text).not.toContain('"type":"keydown"');
    expect(text).not.toContain("ime:idle");
  });

  test("⌘⌥⇧I starts it, and pressed again copies it and stops it", async () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    start();
    toggle();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(typesSeen(added)).toEqual(
      expect.arrayContaining([
        "keydown",
        "compositionstart",
        "beforeinput",
        "input",
        "selectionchange",
      ]),
    );
    typeKey();
    traceIme({ type: "ime:enter" });
    toggle();
    const text = await copied();
    expect(text.split("\n")[0]).toContain("Macintosh");
    expect(text).toContain('"type":"keydown"');
    expect(text).toContain('"type":"ime:enter"');
    expect(onCopied).toHaveBeenCalledOnce();
    expect(typesSeen(removed)).toEqual(typesSeen(added));

    // Stopped: what is typed now is not kept, nor what ime-commit says.
    typeKey();
    traceIme({ type: "ime:after" });
    toggle();
    toggle();
    const again = await copied();
    expect(again).not.toContain('"type":"keydown"');
    expect(again).not.toContain("ime:after");
    expect(onStarted).toHaveBeenCalledTimes(2);
  });

  test("a key in a plain field is kept with the field's counts, before and after", async () => {
    start();
    toggle();
    field.value = "abc";
    field.setSelectionRange(1, 1);
    typeKey();
    // The field after the key, once every handler has run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    toggle();
    const [key] = (await entriesCopied()).filter((entry) => entry.type === "keydown");
    expect(key).toMatchObject({
      key: "char",
      target: "textarea",
      inEditor: false,
      fieldLen: 3,
      selStart: 1,
      selEnd: 1,
      fieldLenAfter: 3,
      selStartAfter: 1,
      blocks: 0,
    });
  });

  test("the selection is kept of a plain field alone", async () => {
    start();
    toggle();
    document.dispatchEvent(new Event("selectionchange"));
    field.blur();
    document.dispatchEvent(new Event("selectionchange"));
    toggle();
    const entries = await entriesCopied();
    expect(entries.filter((entry) => entry.type === "selectionchange")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "focusout")).toHaveLength(1);
  });

  test("with memoca:ime-trace set to 1, is kept from the load", async () => {
    localStorage.setItem("memoca:ime-trace", "1");
    const added = vi.spyOn(document, "addEventListener");
    start();
    expect(typesSeen(added)).toContain("keydown");
    typeKey();
    toggle();
    expect(onStarted).not.toHaveBeenCalled();
    expect(await copied()).toContain('"type":"keydown"');
    expect(onCopied).toHaveBeenCalledOnce();
  });

  test("outside the desktop shell, or off a Mac, there is none", () => {
    const added = vi.spyOn(window, "addEventListener");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(SAFARI_MAC);
    start();
    expect(added).not.toHaveBeenCalled();
    toggle();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
