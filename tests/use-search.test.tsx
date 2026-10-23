import "fake-indexeddb/auto";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { useSearch } from "@/lib/hooks/use-search";
import type { SearchHit } from "@/lib/search/engine";
import type { Note } from "@/lib/types";
import { zero } from "./helpers/seed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = (noteId: string, title: string): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title,
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
});

let root: Root;
let host: HTMLDivElement;
/** What each render found. */
let seen: SearchHit[][];

function Probe({
  query,
  enabled,
  found,
}: {
  query: string;
  enabled: boolean;
  found: (hits: SearchHit[]) => void;
}) {
  const { hits } = useSearch(query, { enabled });
  found(hits);
  return null;
}

/** Lets the live query read the tables and the hook settle on what it found. */
const settle = async () => {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    });
  }
};

/**
 * Settles until `done` holds, for what is expected to happen. A fixed number
 * of rounds is enough on one Node and not on another: from Node 24.21, as
 * CI runs, fake-indexeddb's reads and Dexie's live query can take more turns
 * of the event loop than settle() gives them. Bounded, so a read that never
 * comes still fails the test rather than hanging it.
 */
const settleUntil = async (done: () => boolean) => {
  for (let round = 0; round < 50 && !done(); round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    });
  }
};

async function render(query: string, enabled: boolean) {
  await act(async () =>
    root.render(<Probe query={query} enabled={enabled} found={(hits) => seen.push(hits)} />),
  );
  await settle();
}

const bodiesRead = () => vi.spyOn(db().bodies, "toArray");

beforeEach(async () => {
  await resetLocalData();
  await db().notes.put(note("n1", "会議メモ"));
  await db().bodies.put({
    noteId: "n1",
    throughSeq: 0,
    keyEpoch: 0,
    text: "見積もりを出す",
    updatedAt: 0,
  });
  seen = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("the search index, built from the device's notes", () => {
  test("is not built while the search is not open: nothing is read, and nothing found", async () => {
    const read = bodiesRead();
    await render("会議", false);
    expect(read).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual([]);

    // A note written meanwhile, as typing in one does every half second,
    // does not have the bodies read either.
    await db().notes.put(note("n2", "買い物"));
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual([]);
  });

  test("is built once it is open, and finds a note", async () => {
    const read = bodiesRead();
    await render("会議", true);
    await settleUntil(() => seen.at(-1)?.length === 1);
    expect(read).toHaveBeenCalled();
    expect(seen.at(-1)?.map((hit) => hit.noteId)).toEqual(["n1"]);
  });
});
