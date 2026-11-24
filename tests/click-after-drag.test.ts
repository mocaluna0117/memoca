import { describe, expect, test } from "vitest";
import { CLICK_SLOP_PX, MOUSE_DRAG_PX, clickAfterAll } from "@/components/shell/workspace-dnd";

describe("a drag that was a click", () => {
  const mouse = { activatorEvent: new MouseEvent("mousedown") };

  test("by a mouse that never went far from where it was pressed: a click that moved", () => {
    expect(clickAfterAll(mouse, MOUSE_DRAG_PX)).toBe(true);
    expect(clickAfterAll(mouse, CLICK_SLOP_PX - 1)).toBe(true);
  });

  test("one that went further, even if brought back: a move, or a move given up", () => {
    expect(clickAfterAll(mouse, CLICK_SLOP_PX)).toBe(false);
    expect(clickAfterAll(mouse, 120)).toBe(false);
  });

  test("a finger's hold never: it is a gesture of its own (a note's menu)", () => {
    expect(clickAfterAll({ activatorEvent: new Event("touchstart") }, 2)).toBe(false);
  });

  test("a mouse moves further before a drag starts than it did (6 px), and less than a click may roll", () => {
    expect(MOUSE_DRAG_PX).toBeGreaterThan(6);
    expect(MOUSE_DRAG_PX).toBeLessThan(CLICK_SLOP_PX);
  });
});
