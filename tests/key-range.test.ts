import { expect, test } from "vitest";
import { uuidv7 } from "uuidv7";
import { journalNoteId } from "@/lib/journal";
import { justAbove, justBelow } from "@/lib/key-range";

test("the bounds take in every other key, and leave the one out", () => {
  const keys = Array.from({ length: 400 }, () => uuidv7());
  // Ones that differ only at the end, the closest there can be.
  keys.push("01a16550-112a-7d53-8dbc-33a42965fbd0", "01a16550-112a-7d53-8dbc-33a42965fbd1");
  keys.push("01a16550-112a-7d53-8dbc-33a42965fbcf", "01a16550-112a-7d53-8dbc-33a42965fbe0");
  // A day's note, and the one made again after it was deleted for good.
  keys.push(journalNoteId("2026-10-23"), `${journalNoteId("2026-10-23")}-${uuidv7().slice(-8)}`);
  for (const key of keys) {
    const below = justBelow(key);
    const above = justAbove(key);
    expect(below < key && key < above).toBe(true);
    for (const other of keys) {
      if (other === key) continue;
      expect(other < key ? other <= below : other >= above).toBe(true);
    }
  }
});
