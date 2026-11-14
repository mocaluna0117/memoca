import { describe, expect, it } from "vitest";
import { actionsFor } from "@/lib/search/palette-actions";

describe("command palette actions", () => {
  it("offers every action before anything is typed", () => {
    expect(actionsFor("  ").size).toBe(6);
  });

  it("offers none for a search no action is named by, so Enter opens nothing", () => {
    expect(actionsFor("議事録").size).toBe(0);
  });

  it("finds an action by its name, a reading, or English", () => {
    expect([...actionsFor("設定")]).toEqual(["settings"]);
    expect([...actionsFor("ごみ")]).toEqual(["trash"]);
    expect([...actionsFor("ゴミ")]).toEqual(["trash"]);
    expect([...actionsFor("Folder")]).toEqual(["new-folder"]);
    expect(actionsFor("そくせき").has("quick-note")).toBe(true);
  });
});
