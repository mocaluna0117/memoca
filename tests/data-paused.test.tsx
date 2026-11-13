import "fake-indexeddb/auto";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { useNotes } from "@/lib/hooks/data";
import type { Note } from "@/lib/types";
import { zero } from "./helpers/seed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = (noteId: string): Note => ({
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
  seq: 1,
  updatedAt: 0,
});

let shown: Note[] = [];
function List({ enabled }: { enabled: boolean }) {
  const notes = useNotes({ kind: "all" }, enabled);
  // Noted once drawn, not while drawing.
  useEffect(() => {
    shown = notes;
  }, [notes]);
  return null;
}

let root: Root;
let host: HTMLDivElement;
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => new Promise((r) => setTimeout(r, 10)));
};

beforeEach(async () => {
  await resetLocalData();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test("a list out of sight reads nothing as notes are written, and catches up once in sight", async () => {
  await db().notes.put(note("n1"));
  await act(() => root.render(<List enabled />));
  await settle();
  expect(shown.map((n) => n.noteId)).toEqual(["n1"]);

  const read = vi.spyOn(db().notes, "toArray");
  await act(() => root.render(<List enabled={false} />));
  await settle();
  read.mockClear();
  // Written to, as a note typed in is every half second: not read again.
  await db().notes.put(note("n2"));
  await db().notes.update("n1", { updatedAt: 5 });
  await settle();
  expect(read).not.toHaveBeenCalled();
  expect(shown.map((n) => n.noteId)).toEqual(["n1"]);

  await act(() => root.render(<List enabled />));
  await settle();
  expect(read).toHaveBeenCalled();
  expect(shown.map((n) => n.noteId).sort()).toEqual(["n1", "n2"]);
});

/** The page put away, or brought back, as a window hidden and shown is. */
function setPageHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("in a window put away, too: nothing read as notes are written (by another window), and caught up as it comes back", async () => {
  try {
    await db().notes.put(note("n1"));
    await act(() => root.render(<List enabled />));
    await settle();
    expect(shown.map((n) => n.noteId)).toEqual(["n1"]);

    setPageHidden(true);
    await settle();
    const read = vi.spyOn(db().notes, "toArray");
    // As the quick note's window writes its tab, every half second typed in.
    await db().notes.put(note("n2"));
    await db().notes.update("n1", { title: "changed" });
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(shown.map((n) => n.noteId)).toEqual(["n1"]);

    setPageHidden(false);
    await settle();
    expect(shown.map((n) => n.noteId).sort()).toEqual(["n1", "n2"]);
    expect(shown.find((n) => n.noteId === "n1")?.title).toBe("changed");
  } finally {
    setPageHidden(false);
  }
});

test("a window made while put away (the desktop app's, before it is first shown) still reads once", async () => {
  try {
    await db().notes.put(note("n1"));
    setPageHidden(true);
    await act(() => root.render(<List enabled />));
    await settle();
    expect(shown.map((n) => n.noteId)).toEqual(["n1"]);
  } finally {
    setPageHidden(false);
  }
});
