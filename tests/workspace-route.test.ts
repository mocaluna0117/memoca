import { afterEach, describe, expect, test } from "vitest";
import { isWorkspaceSegments, moveWithinWorkspace, workspaceView } from "@/lib/workspace-route";

describe("workspaceView", () => {
  test("the notes and each other page of the workspace", () => {
    expect(workspaceView("/app")).toBe("");
    expect(workspaceView("/app/")).toBe("");
    expect(workspaceView("/app/search")).toBe("search");
    expect(workspaceView("/app/trash/")).toBe("trash");
    expect(workspaceView("/app/admin")).toBe("admin");
  });

  test("none for what is not one of its pages", () => {
    expect(workspaceView("/quick")).toBeNull();
    expect(workspaceView("/")).toBeNull();
    expect(workspaceView("/application")).toBeNull();
    expect(workspaceView("/app/nothing")).toBeNull();
    expect(workspaceView("/app/search/more")).toBeNull();
    expect(workspaceView("/app/constructor")).toBeNull();
  });

  test("the route's segments", () => {
    expect(isWorkspaceSegments(undefined)).toBe(true);
    expect(isWorkspaceSegments([])).toBe(true);
    expect(isWorkspaceSegments(["settings"])).toBe(true);
    expect(isWorkspaceSegments(["settings", "x"])).toBe(false);
    expect(isWorkspaceSegments(["x"])).toBe(false);
  });
});

describe("moveWithinWorkspace", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  test("from one page of the workspace to another, by the address alone", () => {
    window.history.replaceState(null, "", "/app?n=a");
    const length = window.history.length;
    expect(moveWithinWorkspace("/app/search")).toBe(true);
    expect(window.location.pathname).toBe("/app/search");
    expect(window.history.length).toBe(length + 1);
    expect(moveWithinWorkspace("/app/settings#hotkeys", { replace: true })).toBe(true);
    expect(window.location.pathname + window.location.hash).toBe("/app/settings#hotkeys");
    expect(window.history.length).toBe(length + 1);
    expect(moveWithinWorkspace("/app?n=b")).toBe(true);
    expect(window.location.search).toBe("?n=b");
  });

  test("not from or to another route: the router's", () => {
    window.history.replaceState(null, "", "/quick");
    expect(moveWithinWorkspace("/app/search")).toBe(false);
    expect(window.location.pathname).toBe("/quick");
    window.history.replaceState(null, "", "/app");
    expect(moveWithinWorkspace("/quick")).toBe(false);
    expect(moveWithinWorkspace("/app/unknown")).toBe(false);
    expect(moveWithinWorkspace("https://example.com/app/search")).toBe(false);
    expect(window.location.pathname).toBe("/app");
  });
});
