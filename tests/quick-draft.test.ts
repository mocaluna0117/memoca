import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetLocalData } from "@/lib/db";
import { DRAFT_DELAY_MS, clearDraft, keepDraft, loadDraft } from "@/lib/quick/draft";

/** Lets Dexie's writes land, fake timers or not. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const textOf = async () => (await loadDraft())?.text ?? null;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

let keeper: ReturnType<typeof keepDraft>;

beforeEach(async () => {
  await resetLocalData();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  keeper = keepDraft();
});

afterEach(async () => {
  keeper.dispose();
  setVisibility("visible");
  vi.useRealTimers();
  await clearDraft();
});

describe("the quick note's draft", () => {
  test("is written once typing pauses, not at every key", async () => {
    keeper.update("買");
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS - 50);
    keeper.update("買い物");
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS - 50);
    await settle();
    expect(await textOf()).toBeNull();

    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(await textOf()).toBe("買い物");
  });

  test("is written at once when the page goes out of sight, or away", async () => {
    keeper.update("隠れる前");
    setVisibility("hidden");
    await settle();
    expect(await textOf()).toBe("隠れる前");

    setVisibility("visible");
    keeper.update("離れる前");
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(await textOf()).toBe("離れる前");
  });

  test("is forgotten when nothing is left in it", async () => {
    keeper.update("消す");
    await keeper.flush();
    keeper.update("  \n ");
    await keeper.flush();
    expect(await loadDraft()).toBeNull();
  });

  test("once saved as a note, what was waiting is not written after all", async () => {
    keeper.update("保存した");
    keeper.cancel();
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS * 2);
    setVisibility("hidden");
    await settle();
    expect(await loadDraft()).toBeNull();
  });

  test("what is waiting is written when the quick note goes away", async () => {
    keeper.update("閉じる前");
    keeper.dispose();
    await settle();
    expect(await textOf()).toBe("閉じる前");
    // A fresh one, for afterEach to put away.
    keeper = keepDraft();
  });
});
