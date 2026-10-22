import { describe, expect, test } from "vitest";
import { sameValue, shareRow, shareRows } from "@/lib/hooks/share-rows";

type Row = {
  noteId: string;
  title: string | null;
  ts: { title: { t: number; d: string } };
  sealed?: { ct: Uint8Array; iv: Uint8Array };
  links?: string[];
};

/** A row as IndexedDB gives it back each time: a new object, equal in value. */
const read = (row: Row): Row => structuredClone(row);

const a: Row = { noteId: "a", title: "A", ts: { title: { t: 1, d: "x" } } };
const b: Row = {
  noteId: "b",
  title: null,
  ts: { title: { t: 2, d: "x" } },
  sealed: { ct: new Uint8Array([1, 2, 3]), iv: new Uint8Array([9]) },
  links: ["a"],
};

describe("sameValue", () => {
  test("compares what IndexedDB holds by value", () => {
    expect(sameValue(read(b), read(b))).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(undefined, null)).toBe(false);
    expect(sameValue({ x: undefined }, {})).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
  });

  test("tells a change anywhere in a row, nested or in bytes", () => {
    expect(sameValue(b, { ...read(b), ts: { title: { t: 3, d: "x" } } })).toBe(false);
    expect(
      sameValue(b, {
        ...read(b),
        sealed: { ct: new Uint8Array([1, 2, 4]), iv: new Uint8Array([9]) },
      }),
    ).toBe(false);
    expect(sameValue(b, { ...read(b), links: ["a", "c"] })).toBe(false);
    expect(sameValue(new Uint8Array([1]), new Uint16Array([1]))).toBe(false);
    expect(sameValue(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer)).toBe(true);
  });
});

describe("shareRows", () => {
  const key = (row: Row) => row.noteId;

  test("nothing changed: the same array, so nothing is drawn again", () => {
    const first = [a, b];
    expect(shareRows(first, [read(a), read(b)], key)).toBe(first);
  });

  test("one row changed: only it is a new object", () => {
    const first = [a, b];
    const changed = { ...read(b), title: "B" };
    const next = shareRows(first, [read(a), changed], key);
    expect(next).not.toBe(first);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(changed);
  });

  test("reordered or added: a new array of the rows kept", () => {
    const first = [a, b];
    const reordered = shareRows(first, [read(b), read(a)], key);
    expect(reordered).not.toBe(first);
    expect(reordered[0]).toBe(b);
    expect(reordered[1]).toBe(a);
    const c = { ...read(a), noteId: "c" };
    const added = shareRows(first, [read(a), read(b), c], key);
    expect(added.slice(0, 2)).toEqual([a, b]);
    expect(added[0]).toBe(a);
    expect(added[2]).toBe(c);
    expect(shareRows(first, [read(a)], key)).toEqual([a]);
  });

  test("nothing before: the rows as read", () => {
    const rows = [read(a)];
    expect(shareRows(undefined, rows, key)).toBe(rows);
    expect(shareRows([], rows, key)).toBe(rows);
  });
});

describe("shareRow", () => {
  test("the same object while it holds the same", () => {
    expect(shareRow(b, read(b))).toBe(b);
    const changed = { ...read(b), title: "B" };
    expect(shareRow(b, changed)).toBe(changed);
    expect(shareRow<Row | null>(undefined, null)).toBe(null);
    expect(shareRow<Row | null>(null, null)).toBe(null);
  });
});
