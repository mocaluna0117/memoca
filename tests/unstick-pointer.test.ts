import { afterEach, describe, expect, test, vi } from "vitest";
import { layerOpen, unstickPointer, watchStuckPointer } from "@/lib/ui/unstick-pointer";

afterEach(() => {
  document.body.style.removeProperty("pointer-events");
  document.body.replaceChildren();
});

/** A layer of Radix's, open or closing, as it is in the page. */
function layer(role: string, state: "open" | "closed") {
  const element = document.createElement("div");
  element.setAttribute("role", role);
  element.dataset.state = state;
  document.body.append(element);
  return element;
}

describe("the page's clicks", () => {
  test("taken with no layer open, are given back", () => {
    document.body.style.pointerEvents = "none";
    expect(unstickPointer()).toBe(true);
    expect(document.body.style.pointerEvents).toBe("");
  });

  test("taken by a dialog, an alert, a menu or a list that is open, are left to it", () => {
    for (const role of ["dialog", "alertdialog", "menu", "listbox"]) {
      document.body.style.pointerEvents = "none";
      const open = layer(role, "open");
      expect(layerOpen()).toBe(true);
      expect(unstickPointer(), role).toBe(false);
      expect(document.body.style.pointerEvents).toBe("none");
      open.remove();
    }
    // One closing, or of another kind (a tooltip): not one that takes them.
    layer("dialog", "closed");
    layer("tooltip", "open");
    expect(unstickPointer()).toBe(true);
  });

  test("not taken, are left as they are", () => {
    expect(unstickPointer()).toBe(false);
  });

  test("are given back as the window comes into focus, is seen again, or a click falls through to the page's root", () => {
    const told = vi.fn();
    const stop = watchStuckPointer(told);
    document.body.style.pointerEvents = "none";
    window.dispatchEvent(new Event("focus"));
    expect(document.body.style.pointerEvents).toBe("");

    document.body.style.pointerEvents = "none";
    document.documentElement.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.body.style.pointerEvents).toBe("");

    document.body.style.pointerEvents = "none";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.body.style.pointerEvents).toBe("");
    expect(told).toHaveBeenCalledTimes(3);

    // A click on the page itself, a layer's own: nothing looked at.
    document.body.style.pointerEvents = "none";
    layer("menu", "open").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.body.style.pointerEvents).toBe("none");
    stop();
  });
});
