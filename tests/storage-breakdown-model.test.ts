import { describe, expect, test } from "vitest";
import {
  type Breakdown,
  type LargeFile,
  MISMATCH_BYTES,
  PARTS,
  amounts,
  freeBytes,
  mismatch,
  placeOf,
  widths,
} from "@/lib/storage/breakdown";
import type { Note } from "@/lib/types";

const breakdown = (over: Partial<Breakdown> = {}): Breakdown => ({
  quotaBytes: 10_000,
  usedBytes: 0,
  reservedBytes: 0,
  recomputedBytes: 0,
  bodies: { live: 0, trashed: 0 },
  files: { image: 0, video: 0, other: 0, locked: 0 },
  trashedFiles: 0,
  unused: { bytes: 0, count: 0, nextDeleteAt: null },
  uploading: 0,
  largest: [],
  truncated: false,
  ...over,
});

const live = (usedBytes: number, reservedBytes = 0, quotaBytes = 10_000) => ({ quotaBytes, usedBytes, reservedBytes });

describe("the parts of the bar", () => {
  test("each takes its own figure, the trash its text and its files together", () => {
    const usage = breakdown({
      files: { image: 1, video: 2, other: 8, locked: 4 },
      bodies: { live: 16, trashed: 32 },
      trashedFiles: 64,
      unused: { bytes: 128, count: 1, nextDeleteAt: 0 },
      uploading: 256,
    });
    expect(amounts(usage, live(511))).toEqual({
      images: 1,
      videos: 2,
      lockedFiles: 4,
      otherFiles: 8,
      text: 16,
      trash: 96,
      unused: 128,
      uploading: 256,
      uncounted: 0,
    });
  });

  test("what the running total holds beyond the rows is shown as not in the breakdown, so the parts are the total above", () => {
    const usage = breakdown({ files: { image: 300, video: 0, other: 0, locked: 0 } });
    const parts = amounts(usage, live(900, 100));
    expect(parts.uncounted).toBe(700);
    expect(PARTS.reduce((sum, part) => sum + parts[part], 0)).toBe(1_000);
    // And none when the rows add up to more.
    expect(amounts(usage, live(200)).uncounted).toBe(0);
  });

  test("the free space is what the page says above: the allowance less what is used and reserved", () => {
    expect(freeBytes(live(2_000, 500))).toBe(7_500);
    expect(freeBytes(live(12_000))).toBe(0);
  });

  test("are drawn in proportion, a sliver at least for any that holds something, never past the whole bar", () => {
    const parts = amounts(breakdown({ files: { image: 5_000, video: 1, other: 0, locked: 0 } }), live(5_001));
    const drawn = widths(parts, 10_000);
    expect(drawn.images).toBeCloseTo(50);
    expect(drawn.videos).toBe(0.5);
    expect(drawn.otherFiles).toBe(0);

    // Over the allowance, and with many slivers: scaled back to fit.
    const crowded = amounts(
      breakdown({ files: { image: 12_000, video: 1, other: 1, locked: 1 }, bodies: { live: 1, trashed: 1 } }),
      live(12_005),
    );
    const total = PARTS.reduce((sum, part) => sum + widths(crowded, 10_000)[part], 0);
    expect(total).toBeLessThanOrEqual(100.0001);
  });
});

describe("the difference between the running total and a recount", () => {
  test("is mentioned past a threshold either way, and never from a count that did not read everything", () => {
    expect(mismatch(breakdown({ usedBytes: MISMATCH_BYTES, recomputedBytes: 0 }))).toBeNull();
    expect(mismatch(breakdown({ usedBytes: MISMATCH_BYTES + 1, recomputedBytes: 0 }))).toBe(MISMATCH_BYTES + 1);
    expect(mismatch(breakdown({ usedBytes: 0, recomputedBytes: MISMATCH_BYTES + 1 }))).toBe(-(MISMATCH_BYTES + 1));
    expect(mismatch(breakdown({ usedBytes: 10_000_000, recomputedBytes: 0, truncated: true }))).toBeNull();
  });
});

describe("where a large file is", () => {
  const file = (over: Partial<LargeFile> = {}): LargeFile => ({
    attachmentId: "f",
    noteId: "owner",
    bytes: 1,
    kind: "image",
    name: "a.webp",
    mime: "image/webp",
    locked: false,
    width: 1,
    height: 1,
    trashed: false,
    unused: false,
    usedBy: [],
    ...over,
  });
  const note = (noteId: string, over: Partial<Note> = {}) =>
    ({ noteId, deletedAt: null, purged: false, ...over }) as Note;

  test("is a note out of the trash that shows it, before one in the trash", () => {
    const notes = new Map([
      ["binned", note("binned", { deletedAt: 1 })],
      ["live", note("live")],
    ]);
    expect(placeOf(file({ usedBy: ["binned", "live"] }), notes)).toEqual({ state: "note", noteId: "live" });
  });

  test("is the trash for a file emptying it would free, or when only notes in the trash show it", () => {
    expect(placeOf(file({ trashed: true }), new Map())).toMatchObject({ state: "trash" });
    const notes = new Map([["binned", note("binned", { deletedAt: 1 })]]);
    expect(placeOf(file({ usedBy: ["binned"] }), notes)).toEqual({ state: "trash", noteId: "binned" });
  });

  test("is no note for a file none uses any more, and a note not here when this device lacks it", () => {
    expect(placeOf(file({ unused: true, usedBy: [] }), new Map([["owner", note("owner")]]))).toMatchObject({
      state: "unused",
    });
    expect(placeOf(file({ usedBy: ["elsewhere"] }), new Map([["elsewhere", undefined]]))).toMatchObject({
      state: "missing",
    });
  });
});
