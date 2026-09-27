import { describe, expect, test } from "vitest";
import { detectQuickMode } from "@/lib/quick/mode";

describe("detectQuickMode", () => {
  test("a window of its own when asked for one, or shown by the desktop shell", () => {
    expect(detectQuickMode({ windowParam: "1", shell: false })).toBe("window");
    expect(detectQuickMode({ windowParam: null, shell: true })).toBe("window");
  });

  test("otherwise a page, whatever else the address says", () => {
    expect(detectQuickMode({ windowParam: null, shell: false })).toBe("page");
    expect(detectQuickMode({ windowParam: "0", shell: false })).toBe("page");
    expect(detectQuickMode({ windowParam: "true", shell: false })).toBe("page");
  });
});
