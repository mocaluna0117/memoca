import { describe, expect, it } from "vitest";
import { isStaleChunk } from "@/lib/ui/stale-chunk";

describe("a part of the app that failed to load", () => {
  it("is told from the error each browser gives", () => {
    const chunk = new Error("Loading chunk 123 failed.");
    chunk.name = "ChunkLoadError";
    expect(isStaleChunk(chunk)).toBe(true);
    expect(isStaleChunk(new TypeError("Failed to fetch dynamically imported module: https://x/_next/a.js"))).toBe(true);
    expect(isStaleChunk(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunk(new Error("Loading CSS chunk 9 failed"))).toBe(true);
  });

  it("is not any other error", () => {
    expect(isStaleChunk(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleChunk("Loading chunk 1 failed")).toBe(false);
  });
});
