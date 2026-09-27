import { describe, expect, test } from "vitest";
import { modKeyLabel } from "@/lib/platform";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  // iPadOS asks for the desktop site, as a Mac.
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  shell:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 MemocaShell/0.1.0 (macos)",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
};

describe("the key held with Enter to save", () => {
  test("is ⌘ on anything of Apple's, the desktop shell on a Mac included", () => {
    for (const agent of [UA.iphone, UA.ipad, UA.macChrome, UA.shell])
      expect(modKeyLabel(agent)).toBe("⌘");
  });

  test("is Ctrl anywhere else", () => {
    for (const agent of [UA.windows, UA.linux, ""]) expect(modKeyLabel(agent)).toBe("Ctrl");
  });
});
