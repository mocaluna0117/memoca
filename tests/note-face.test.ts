import { describe, expect, test } from "vitest";
import { sameNoteFace, sameRowProps } from "@/lib/note-face";
import type { Note } from "@/lib/types";
import { zero } from "./helpers/seed";

const note: Note = {
  noteId: "n1",
  folderId: "f1",
  kind: "note",
  title: "メモ",
  preview: "一行目",
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
};

describe("a note's face, as a row shows it", () => {
  test("is the same while what the sync keeps on it moves", () => {
    const moved: Note = {
      ...note,
      lastUpdateSeq: 9,
      seq: 12,
      snapshotSeq: 3,
      refsThroughSeq: 9,
      updatedAt: 99_999,
      ts: { ...note.ts, preview: { t: 5, d: "x" }, place: { t: 6, d: "x" } },
    };
    expect(sameNoteFace(note, moved)).toBe(true);
  });

  test("changes with what it shows, and what its actions take from it", () => {
    const faces: Partial<Note>[] = [
      { title: "別" },
      { preview: "二行目" },
      { pinned: true },
      { locked: true },
      { keyEpoch: 1 },
      { folderId: "f2" },
      { deletedAt: 1 },
      { ts: { ...note.ts, title: { t: 1, d: "d" } } },
    ];
    for (const face of faces) expect(sameNoteFace(note, { ...note, ...face })).toBe(false);
  });
});

describe("a row's props", () => {
  test("say the same by the note's face and everything else as it is", () => {
    const actions = {};
    const prev = { note, when: "たった今", selected: false, actions };
    expect(sameRowProps(prev, { ...prev, note: { ...note, lastUpdateSeq: 4 } })).toBe(true);
    expect(sameRowProps(prev, { ...prev, when: "1 分前" })).toBe(false);
    expect(sameRowProps(prev, { ...prev, selected: true })).toBe(false);
    expect(sameRowProps(prev, { ...prev, actions: {} })).toBe(false);
  });

  test("a prop with a comparison of its own is compared by it", () => {
    const prev = { note, drag: { dragging: false, style: { transform: "a" } } };
    const next = { note, drag: { dragging: false, style: { transform: "a" } } };
    expect(sameRowProps(prev, next)).toBe(false);
    const byParts = (a: typeof prev.drag, b: typeof prev.drag) =>
      a.dragging === b.dragging && a.style.transform === b.style.transform;
    expect(sameRowProps(prev, next, { drag: byParts })).toBe(true);
    expect(
      sameRowProps(prev, { ...next, drag: { ...next.drag, dragging: true } }, { drag: byParts }),
    ).toBe(false);
  });
});
