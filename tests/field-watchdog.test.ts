import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachFieldWatchdog } from "@/lib/quick/field-watchdog";

let field: HTMLTextAreaElement;
let told = "";
let resync: ReturnType<typeof vi.fn<(value: string) => void>>;
let trace: ReturnType<typeof vi.fn<(entry: Record<string, string | number | boolean | null>) => void>>;
let stop: () => void;

const setValue = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
};
const keyComposing = () =>
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "a", isComposing: true, bubbles: true }));
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  told = "";
  resync = vi.fn<(value: string) => void>((value) => {
    told = value;
  });
  trace = vi.fn<(entry: Record<string, string | number | boolean | null>) => void>();
  stop = attachFieldWatchdog(field, { told: () => told, resync, trace, stallMs: 2_000, everyMs: 1_000 });
});

afterEach(() => {
  stop();
  field.remove();
  vi.useRealTimers();
});

test("what the field holds, not told to the app, is told from the field", async () => {
  setValue("打った");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await tick(0);
  expect(resync).toHaveBeenCalledWith("打った");
  expect(trace).toHaveBeenCalledWith(expect.objectContaining({ type: "quick:desync" }));
  // The same, once told: nothing more to say.
  resync.mockClear();
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await tick(0);
  expect(resync).not.toHaveBeenCalled();
});

test("with no event at all, the field is checked now and then while focused", async () => {
  setValue("静かに");
  await tick(1_100);
  expect(resync).toHaveBeenCalledWith("静かに");
});

test("a composition stuck on keys that compose nothing is shaken loose, once in a while", async () => {
  const blur = vi.spyOn(field, "blur");
  const focus = vi.spyOn(field, "focus");
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  keyComposing();
  keyComposing();
  keyComposing();
  await tick(2_100);
  expect(trace).toHaveBeenCalledWith(expect.objectContaining({ type: "quick:stuck-composition" }));
  expect(blur).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledTimes(1);
  // Stuck again straight after: noted, not shaken again so soon.
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  keyComposing();
  keyComposing();
  keyComposing();
  await tick(2_100);
  expect(blur).toHaveBeenCalledTimes(1);
});

test("a composition that goes on, slowly, is left alone", async () => {
  const blur = vi.spyOn(field, "blur");
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  for (let i = 0; i < 4; i += 1) {
    keyComposing();
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "に" }));
    await tick(1_500);
  }
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
  await tick(2_100);
  expect(blur).not.toHaveBeenCalled();
  expect(trace).not.toHaveBeenCalledWith(expect.objectContaining({ type: "quick:stuck-composition" }));
});
