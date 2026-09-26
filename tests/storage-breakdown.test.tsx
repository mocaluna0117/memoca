import "fake-indexeddb/auto";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StorageBreakdown, forgetStorageBreakdown } from "@/components/settings/storage-breakdown";
import { db, resetLocalData } from "@/lib/db";
import type { Breakdown } from "@/lib/storage/breakdown";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const breakdown = (over: Partial<Breakdown> = {}): Breakdown => ({
  quotaBytes: 100_000,
  usedBytes: 3_000,
  reservedBytes: 0,
  recomputedBytes: 3_000,
  bodies: { live: 1_000, trashed: 0 },
  files: { image: 2_000, video: 0, other: 0, locked: 0 },
  trashedFiles: 0,
  unused: { bytes: 0, count: 0, nextDeleteAt: null },
  uploading: 0,
  largest: [],
  truncated: false,
  ...over,
});

const note = (noteId: string, over: Partial<Note> = {}): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title: noteId,
  preview: null,
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 0,
  updatedAt: 0,
  ...over,
});

let root: Root;
let host: HTMLDivElement;
let server: ReturnType<typeof fakeConvex>;
let answer: () => unknown;

const figures = { quotaBytes: 100_000, usedBytes: 3_000, reservedBytes: 0 };

async function render(props: { account?: string; admin?: boolean } = {}) {
  await act(async () => {
    root.render(
      <ConvexProvider client={server.client as ConvexReactClient}>
        <StorageBreakdown account={props.account ?? "a"} live={figures} admin={props.admin ?? false} />
      </ConvexProvider>,
    );
  });
  await settle();
}

/** Lets the fetch and Dexie's live queries come back. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

const asked = () => server.callsTo("usage:breakdown").length;
const text = () => host.textContent ?? "";
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(name))!;

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

beforeEach(async () => {
  await resetLocalData();
  forgetStorageBreakdown();
  push.mockReset();
  answer = () => breakdown();
  server = fakeConvex({ "usage:breakdown": () => answer() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setOnline(true);
});

describe("the storage breakdown", () => {
  test("is worked out once when the page opens, not again as notes change, and again on 更新", async () => {
    await render();
    expect(asked()).toBe(1);
    expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "画像 2.0 KB、メモの本文 1000 B、空き 95 KB",
    );

    await act(async () => {
      await db().notes.put(note("edited"));
    });
    await settle();
    expect(asked()).toBe(1);

    await act(async () => button("更新").click());
    await settle();
    expect(asked()).toBe(2);
  });

  test("offline, says so and does not ask; asks once the network is back", async () => {
    setOnline(false);
    await render();
    expect(asked()).toBe(0);
    expect(text()).toContain("オフラインのため、内訳を表示できません");

    await act(async () => setOnline(true));
    await settle();
    expect(asked()).toBe(1);
    expect(text()).toContain("メモの本文");
  });

  test("a refresh that fails says so, and keeps the figures it had", async () => {
    await render();
    answer = () => {
      throw new Error("server error");
    };
    await act(async () => button("更新").click());
    await settle();
    expect(text()).toContain("内訳を読み込めませんでした");
    expect(text()).toContain("メモの本文");
  });

  test("one worked out a moment ago is shown again without asking, for the same account only", async () => {
    await render();
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(asked()).toBe(1);

    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ account: "someone else" });
    expect(asked()).toBe(2);
  });

  test("only the admin is told that the running total and the recount disagree", async () => {
    answer = () => breakdown({ usedBytes: 500_000, recomputedBytes: 3_000 });
    await render();
    expect(text()).not.toContain("管理者向け");
    await act(async () => root.unmount());
    forgetStorageBreakdown();
    root = createRoot(host);
    await render({ admin: true });
    expect(text()).toContain("管理者向け");
  });

  test("its large files open the note that shows them, the trash, or nothing, as they are", async () => {
    await db().notes.bulkPut([note("binned", { deletedAt: 1 }), note("live", { title: "旅行" })]);
    const file = {
      noteId: "binned",
      bytes: 1_000,
      kind: "image" as const,
      mime: "image/webp",
      locked: false,
      width: 10,
      height: 10,
      trashed: false,
      unused: false,
    };
    answer = () =>
      breakdown({
        largest: [
          { ...file, attachmentId: "shared", name: "shared.webp", usedBy: ["binned", "live"] },
          { ...file, attachmentId: "binned-only", name: "binned.webp", trashed: true, usedBy: ["binned"] },
          { ...file, attachmentId: "old", name: "old.webp", unused: true, usedBy: [] },
        ],
      });
    await render();

    expect(button("shared.webp").textContent).toContain("「旅行」");
    await act(async () => button("shared.webp").click());
    expect(push).toHaveBeenLastCalledWith("/app?n=live");

    expect(button("binned.webp").textContent).toContain("ゴミ箱の中");
    await act(async () => button("binned.webp").click());
    expect(push).toHaveBeenLastCalledWith("/app/trash");

    expect(button("old.webp")).toBeUndefined();
    expect(text()).toContain("どのメモにも使われていません");
  });
});
