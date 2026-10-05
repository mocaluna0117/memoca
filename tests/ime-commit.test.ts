import { describe, expect, test } from "vitest";
import { strayLine } from "@/components/editor/ime-commit";

const line = (id: string, children: unknown[] = []) => ({ id, content: [], children });

describe("a line a commit from the input method left the caret in", () => {
  test("goes, its word kept in the line it was written in", () => {
    expect(strayLine("a", line("b"), line("a"))).toEqual({ keep: "a", drop: "b" });
  });

  test("is left alone when the caret stayed where the word was written", () => {
    expect(strayLine("a", line("a"), line("x"))).toBeNull();
  });

  test("is left alone unless it is right after that line, with nothing under it", () => {
    expect(strayLine("a", line("b"), line("c"))).toBeNull();
    expect(strayLine("a", line("b"), undefined)).toBeNull();
    expect(strayLine("a", line("b", [line("c")]), line("a"))).toBeNull();
    expect(strayLine(null, line("b"), line("a"))).toBeNull();
  });
});
