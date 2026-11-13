import { defaultFilter } from "cmdk";
import { expect, test } from "vitest";
import { byName } from "@/components/folders/folder-picker";

const ID = "0192f3a4-7b1c-7def-8abc-1234567890ab";

test("a folder is found by its name, not by its id", () => {
  // Before: what was matched was the id and the name together.
  expect(defaultFilter(`${ID} 仕事`, "abc")).toBeGreaterThan(0);
  expect(byName(ID, "abc", ["仕事"])).toBe(0);
  expect(byName(ID, "2024", ["仕事"])).toBe(0);
  expect(byName(ID, "仕事", ["仕事"])).toBeGreaterThan(0);
  expect(byName(ID, "cafe", ["Cafe めぐり"])).toBeGreaterThan(0);
});
