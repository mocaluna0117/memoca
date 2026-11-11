import { beforeEach, describe, expect, test } from "vitest";
import {
  STYLE_KEY,
  STYLE_SCRIPT,
  applyStyle,
  isStyle,
  markStyleUnsent,
  styleHere,
  styleUnsent,
} from "@/lib/style";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.style;
});

describe("the app's look on this device", () => {
  test("put on the page and kept; the first, the page's own colours with no attribute", () => {
    expect(styleHere()).toBe("stylish");
    applyStyle("cute");
    expect(document.documentElement.dataset.style).toBe("cute");
    expect(styleHere()).toBe("cute");
    applyStyle("stylish");
    expect(document.documentElement.dataset.style).toBeUndefined();
    expect(styleHere()).toBe("stylish");
  });

  test("before the page is drawn: the kept look on, one there is not left off", () => {
    localStorage.setItem(STYLE_KEY, "retro");
    new Function(STYLE_SCRIPT)();
    expect(document.documentElement.dataset.style).toBe("retro");

    delete document.documentElement.dataset.style;
    localStorage.setItem(STYLE_KEY, "neon");
    new Function(STYLE_SCRIPT)();
    expect(document.documentElement.dataset.style).toBeUndefined();
    expect(styleHere()).toBe("stylish");
  });

  test("one chosen here, until the account has it", () => {
    expect(styleUnsent()).toBeNull();
    markStyleUnsent("natural");
    expect(styleUnsent()).toBe("natural");
    markStyleUnsent(null);
    expect(styleUnsent()).toBeNull();
  });

  test("the looks there are, and no others", () => {
    for (const style of ["stylish", "cute", "natural", "fresh", "retro"]) expect(isStyle(style)).toBe(true);
    expect(isStyle("neon")).toBe(false);
    expect(isStyle(null)).toBe(false);
  });
});
