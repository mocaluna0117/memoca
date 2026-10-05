import { describe, expect, test } from "vitest";
import { isCompositionEnter } from "@/components/editor/ime-enter";

const input = (inputType: string, isComposing = false) => ({ inputType, isComposing });

describe("a line the browser makes for the Enter that commits a word", () => {
  test("is told while the word is still being composed", () => {
    expect(isCompositionEnter(input("insertParagraph", true), false, Infinity)).toBe(true);
    expect(isCompositionEnter(input("insertParagraph"), true, Infinity)).toBe(true);
    expect(isCompositionEnter(input("insertLineBreak", true), false, Infinity)).toBe(true);
  });

  test("and straight after it was committed", () => {
    expect(isCompositionEnter(input("insertParagraph"), false, 20)).toBe(true);
  });

  test("but not an Enter of its own, a moment later", () => {
    expect(isCompositionEnter(input("insertParagraph"), false, 400)).toBe(false);
  });

  test("and never the word itself, or anything else typed", () => {
    expect(isCompositionEnter(input("insertCompositionText", true), true, 0)).toBe(false);
    expect(isCompositionEnter(input("insertText", true), true, 0)).toBe(false);
  });
});
