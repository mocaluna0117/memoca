import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  STALE_MS,
  desktopGuideDone,
  guideFrom,
  nextStep,
  rememberDesktopGuideDone,
  setGuide,
  storedGuide,
  subscribeGuide,
} from "@/lib/guide";

beforeEach(() => localStorage.clear());

describe("where the guide is, kept on the device", () => {
  test("put at a step, read back; ended, none", () => {
    setGuide({ flow: "web", step: "open-quick", at: Date.now() });
    expect(guideFrom(storedGuide())?.step).toBe("open-quick");
    setGuide(null);
    expect(guideFrom(storedGuide())).toBeNull();
  });

  test("left at a step for long, over: not picked up later", () => {
    const at = Date.now();
    setGuide({ flow: "desktop", step: "save", at });
    expect(guideFrom(storedGuide(), at + STALE_MS - 1)?.step).toBe("save");
    expect(guideFrom(storedGuide(), at + STALE_MS)).toBeNull();
  });

  test("what is not a guide's (another version's step, or broken), none", () => {
    localStorage.setItem("memoca:guide", JSON.stringify({ flow: "web", step: "gone", at: Date.now() }));
    expect(guideFrom(storedGuide())).toBeNull();
    localStorage.setItem("memoca:guide", "{");
    expect(guideFrom(storedGuide())).toBeNull();
  });

  test("told to this window as it changes, as to the others", () => {
    const told = vi.fn();
    const stop = subscribeGuide(told);
    setGuide({ flow: "web", step: "intro", at: Date.now() });
    expect(told).toHaveBeenCalled();
    stop();
    told.mockClear();
    setGuide(null);
    expect(told).not.toHaveBeenCalled();
  });
});

describe("each flow's steps, in order", () => {
  test("the web's: the quick note, saved, the note's lines; the desktop app's: its hotkeys and its windows", () => {
    const walk = (flow: "web" | "desktop") => {
      const steps: string[] = [];
      let state: { flow: typeof flow; step: never; at: number } | null = { flow, step: "intro" as never, at: 0 };
      while (state) {
        steps.push(state.step);
        const next = nextStep(state);
        state = next ? { flow, step: next as never, at: 0 } : null;
      }
      return steps;
    };
    expect(walk("web")).toEqual(["intro", "open-quick", "save-quick", "open-note", "bullet", "slash", "finish"]);
    expect(walk("desktop")).toEqual([
      "intro",
      "write",
      "hide-show",
      "save",
      "open-app",
      "app-here",
      "hotkey",
      "finish",
    ]);
  });

  test("the desktop app's, once done, done on this computer", () => {
    expect(desktopGuideDone()).toBe(false);
    rememberDesktopGuideDone();
    expect(desktopGuideDone()).toBe(true);
  });
});
