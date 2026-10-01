import { expect, test } from "vitest";
import { enterFromTitle, onTitleEnter } from "@/components/editor/title-enter";

test("Enter in a title goes to the editor showing that note, and to none once it is gone", () => {
  expect(enterFromTitle("a")).toBe(false);
  const first = onTitleEnter("a", () => true);
  expect(enterFromTitle("a")).toBe(true);
  expect(enterFromTitle("b")).toBe(false);
  // A second editor for the note (shown again): the first, gone after, leaves it.
  let second = 0;
  const undoSecond = onTitleEnter("a", () => {
    second += 1;
    return true;
  });
  first();
  expect(enterFromTitle("a")).toBe(true);
  expect(second).toBe(1);
  undoSecond();
  expect(enterFromTitle("a")).toBe(false);
});
