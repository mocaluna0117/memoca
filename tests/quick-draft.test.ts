import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { DRAFT_DELAY_MS, clearDraft, keepDraft, loadDraft } from "@/lib/quick/draft";

const ME = "user-me";

/** Lets Dexie's writes land, fake timers or not. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const textOf = async (userKey = ME) => (await loadDraft(userKey))?.text ?? null;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

let keeper: ReturnType<typeof keepDraft>;

beforeEach(async () => {
  await resetLocalData();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  keeper = keepDraft(ME);
  keeper.release();
});

afterEach(async () => {
  vi.restoreAllMocks();
  keeper.dispose();
  setVisibility("visible");
  await settle();
  vi.useRealTimers();
  await clearDraft(ME);
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

  test("is not written before the one already there has been read", async () => {
    await setMeta(META.quickDraft, { text: "前の", updatedAt: 0, userKey: ME });
    const reading = keepDraft(ME);
    try {
      reading.update("新しい");
      await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS * 2);
      setVisibility("hidden");
      window.dispatchEvent(new Event("pagehide"));
      await reading.flush(true);
      await settle();
      expect(await textOf()).toBe("前の");

      // Read and offered: now what the field holds is written, once typing pauses.
      setVisibility("visible");
      reading.release();
      await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS);
      await settle();
      expect(await textOf()).toBe("新しい");
    } finally {
      reading.dispose();
    }
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

  test("going out of sight writes what this window holds, over what another wrote meanwhile", async () => {
    keeper.update("この窓");
    await keeper.flush();
    await setMeta(META.quickDraft, { text: "別の窓", updatedAt: 0, userKey: ME });

    // Unchanged here since it was written: a pause does not write it again...
    await keeper.flush();
    expect(await textOf()).toBe("別の窓");
    // ...but the page going away might be the last this window runs.
    setVisibility("hidden");
    await settle();
    expect(await textOf()).toBe("この窓");
  });

  test("is forgotten when nothing is left in it", async () => {
    keeper.update("消す");
    await keeper.flush();
    keeper.update("  \n ");
    await keeper.flush();
    expect(await loadDraft(ME)).toBeNull();
  });

  test("once saved as a note, what was waiting is not written after all", async () => {
    keeper.update("保存した");
    keeper.cancel();
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS * 2);
    setVisibility("hidden");
    await settle();
    expect(await loadDraft(ME)).toBeNull();
  });

  test("a flush is done only once the draft is written: a window may close straight after", async () => {
    let written!: () => void;
    const put = vi
      .spyOn(db().meta, "put")
      .mockImplementation(
        () => new Promise((resolve) => (written = () => resolve(META.quickDraft))) as never,
      );
    keeper.update("閉じる前");
    let done = false;
    const flushed = keeper.flush().then(() => {
      done = true;
    });
    await settle();
    expect(put).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    written();
    await flushed;
    expect(done).toBe(true);
  });

  test("what is waiting is written when the quick note goes away", async () => {
    keeper.update("閉じる前");
    keeper.dispose();
    await settle();
    expect(await textOf()).toBe("閉じる前");
    // A fresh one, for afterEach to put away.
    keeper = keepDraft(ME);
  });

  test("is forgotten only by the account that wrote it", async () => {
    await setMeta(META.quickDraft, { text: "前の人の下書き", updatedAt: 0, userKey: "user-other" });
    // An empty field here, and a save, say nothing about another account's draft.
    keeper.update("");
    await keeper.flush(true);
    await clearDraft(ME);
    expect(await textOf("user-other")).toBe("前の人の下書き");
    await clearDraft("user-other");
    expect(await textOf("user-other")).toBeNull();
  });

  test("is the account's that wrote it: another signed in on the device is not shown it", async () => {
    keeper.update("私の下書き");
    await keeper.flush();
    expect(await textOf("user-other")).toBeNull();
    expect(await textOf()).toBe("私の下書き");
    // One kept before drafts knew their account is no one's.
    await setMeta(META.quickDraft, { text: "古い下書き", updatedAt: 0 });
    expect(await textOf()).toBeNull();
  });
});
