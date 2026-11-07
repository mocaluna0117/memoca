import { describe, expect, test } from "vitest";
import { folderRevealTop } from "@/lib/folder-reveal";

// A sidebar 400 px tall, a top-level folder's row kept at its very top.
const view = { stickyTop: 0, viewHeight: 400 };

describe("a folder opened in the sidebar's tree, scrolled to", () => {
  test("its row scrolled past (the tree scrolled down in another folder's notes): back up to it", () => {
    // Opened at 600 px, the tree scrolled to 1500: its row at the top.
    expect(folderRevealTop({ ...view, current: 1500, groupTop: 600, groupBottom: 1400 })).toBe(600);
    // Scrolled to just past its row: its first note under it again.
    expect(folderRevealTop({ ...view, current: 610, groupTop: 600, groupBottom: 700 })).toBe(600);
  });

  test("further down than is in sight, and long: its row at the top, its notes under it", () => {
    expect(folderRevealTop({ ...view, current: 0, groupTop: 900, groupBottom: 2000 })).toBe(900);
    // Its row in sight at the bottom, its notes not.
    expect(folderRevealTop({ ...view, current: 0, groupTop: 380, groupBottom: 1200 })).toBe(380);
  });

  test("short, its end out of sight: only as far as shows the whole of it", () => {
    // From 300 to 500 px, the tree at its top: 100 px, its last note at the bottom.
    expect(folderRevealTop({ ...view, current: 0, groupTop: 300, groupBottom: 500 })).toBe(100);
  });

  test("all of it in sight already: left where it is", () => {
    expect(folderRevealTop({ ...view, current: 0, groupTop: 100, groupBottom: 300 })).toBe(0);
    expect(folderRevealTop({ ...view, current: 200, groupTop: 250, groupBottom: 550 })).toBe(200);
  });

  test("inside another folder: under that one's row, kept at the top", () => {
    // One folder down (2 rem, 32 px): its row 32 px down, not at the very top.
    expect(
      folderRevealTop({ stickyTop: 32, viewHeight: 400, current: 1500, groupTop: 600, groupBottom: 1400 }),
    ).toBe(568);
  });

  test("never above the top of the tree", () => {
    expect(folderRevealTop({ stickyTop: 32, viewHeight: 400, current: 0, groupTop: 10, groupBottom: 900 })).toBe(0);
  });
});
