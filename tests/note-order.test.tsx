import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useNoteOrder } from "@/lib/hooks/use-note-order";
import { type NoteOrder, createdAt, orderNotes, placeAt } from "@/lib/note-order";
import type { Note } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const zero = { t: 0, d: "d" };
const note = (noteId: string, over: Partial<Note> = {}): Note => ({
  noteId,
  folderId: "f",
  kind: "note",
  title: noteId,
  preview: null,
  pinned: false,
  sortKey: "V",
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

const ids = (notes: Note[]) => notes.map((each) => each.noteId);

describe("ordering a list of notes", () => {
  // Ids made from the time: 01 before 02 before 03.
  const a = note("01-a", { title: "りんご", updatedAt: 3, sortKey: "k" });
  const b = note("02-b", { title: "10月の予定", updatedAt: 1, sortKey: "V" });
  const c = note("03-c", { title: "2月の予定", updatedAt: 2, sortKey: "z" });

  test("last changed first, as it always was", () => {
    expect(ids(orderNotes([a, b, c], "updated"))).toEqual(["01-a", "03-c", "02-b"]);
  });

  test("last made first", () => {
    expect(ids(orderNotes([a, b, c], "created"))).toEqual(["03-c", "02-b", "01-a"]);
  });

  test("by name, numbers as numbers, and a locked note by its name as shown", () => {
    expect(ids(orderNotes([a, b, c], "title"))).toEqual(["03-c", "02-b", "01-a"]);
    const locked = note("04-d", { title: null, locked: true, updatedAt: 9 });
    // Shown as わさび: after りんご, where its missing title would put it first.
    const names = new Map([["04-d", "わさび"]]);
    expect(ids(orderNotes([a, locked], "title", names))).toEqual(["01-a", "04-d"]);
  });

  test("by hand, as placed, and of two sharing a key the newer first", () => {
    expect(ids(orderNotes([a, b, c], "manual"))).toEqual(["02-b", "01-a", "03-c"]);
    const older = note("05-e", { sortKey: "V" });
    const newer = note("06-f", { sortKey: "V" });
    expect(ids(orderNotes([older, newer], "manual"))).toEqual(["06-f", "05-e"]);
  });

  test("pinned first, whichever order", () => {
    const pinned = note("00-p", { pinned: true, updatedAt: 0, sortKey: "zz", title: "ん" });
    for (const order of ["updated", "created", "title", "manual"] as NoteOrder[]) {
      expect(orderNotes([a, pinned, b], order)[0]!.noteId).toBe("00-p");
    }
  });
});

describe("placing a note by hand", () => {
  const others = [
    { noteId: "a", sortKey: "F" },
    { noteId: "b", sortKey: "V" },
  ];

  test("between its new neighbours, the others left as they are", () => {
    const top = placeAt(others, 0);
    expect(top.rekeyed).toEqual([]);
    expect(top.key < "F").toBe(true);
    const middle = placeAt(others, 1);
    expect(middle.key > "F" && middle.key < "V").toBe(true);
    const bottom = placeAt(others, 2);
    expect(bottom.key > "V").toBe(true);
  });

  test("between two sharing a key: those from there that share it given new ones, and no other", () => {
    const shared = [
      { noteId: "a", sortKey: "F" },
      { noteId: "b", sortKey: "V" },
      { noteId: "c", sortKey: "V" },
      { noteId: "d", sortKey: "V" },
      { noteId: "e", sortKey: "k" },
    ];
    const { key, rekeyed } = placeAt(shared, 2);
    expect(rekeyed.map((each) => each.noteId)).toEqual(["c", "d"]);
    const keys = ["F", "V", key, rekeyed[0]!.sortKey, rekeyed[1]!.sortKey, "k"];
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    // Two sharing a key elsewhere in the list: nothing but the note is moved.
    expect(placeAt(shared, 5)).toMatchObject({ rekeyed: [] });
    expect(placeAt(shared, 1)).toMatchObject({ rekeyed: [] });
    // At the end, sharing the last key: those after it, with nothing past them.
    const last = placeAt(
      [
        { noteId: "x", sortKey: "V" },
        { noteId: "y", sortKey: "V" },
      ],
      1,
    );
    expect(last.rekeyed.map((each) => each.noteId)).toEqual(["y"]);
    expect("V" < last.key && last.key < last.rekeyed[0]!.sortKey).toBe(true);
  });
});

describe("the order set for a list, on this device", () => {
  let root: Root;
  let host: HTMLDivElement;
  let seen: [NoteOrder, (order: NoteOrder) => void][];

  function Probe({ folderId }: { folderId: string | null }) {
    seen.push(useNoteOrder(folderId));
    return null;
  }

  beforeEach(() => {
    localStorage.clear();
    seen = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  test("last changed first until set, then as set, each folder its own", async () => {
    await act(async () => root.render(<Probe folderId="f" />));
    expect(seen.at(-1)![0]).toBe("updated");
    act(() => seen.at(-1)![1]("manual"));
    expect(seen.at(-1)![0]).toBe("manual");
    await act(async () => root.render(<Probe folderId="g" />));
    expect(seen.at(-1)![0]).toBe("updated");
    await act(async () => root.render(<Probe folderId="f" />));
    expect(seen.at(-1)![0]).toBe("manual");
  });

  test("all notes are never placed by hand", async () => {
    await act(async () => root.render(<Probe folderId={null} />));
    act(() => seen.at(-1)![1]("manual"));
    expect(seen.at(-1)![0]).toBe("updated");
    act(() => seen.at(-1)![1]("title"));
    expect(seen.at(-1)![0]).toBe("title");
  });

  test("something not an order kept there is taken as none", async () => {
    localStorage.setItem("memoca:note-order", JSON.stringify({ f: "sideways" }));
    await act(async () => root.render(<Probe folderId="f" />));
    expect(seen.at(-1)![0]).toBe("updated");
  });
});

test("when a note was made, from its id", () => {
  // 0x0192…: a UUIDv7's first 48 bits are the time, in milliseconds.
  expect(createdAt("01920000-0000-7000-8000-000000000000")).toBe(0x019200000000);
  expect(createdAt("0192abcd-ef01-7abc-8000-000000000000")).toBe(0x0192abcdef01);
  expect(createdAt("inbox")).toBeNull();
  expect(createdAt("0192abcd-ef01-4abc-8000-000000000000")).toBeNull();
});
