"use client";

/**
 * The hands-on welcome (components/onboarding/guide): where it is, kept on
 * this device and told to its other windows, so the desktop app's two (the
 * quick note's and Memoca's own) carry one guide between them, and a tab
 * keeps it across /app and /quick.
 *
 * Two of them: the web's (a browser, a phone), once an account, started on
 * /app; and the desktop app's, about its hotkeys and its two windows, once a
 * computer.
 */

export type GuideFlow = "web" | "desktop";

/** Each flow's steps, in order. */
export const STEPS = {
  // open-note only where the quick note is a window of its own (a computer's
  // browser): elsewhere saving goes to the note.
  web: ["intro", "open-quick", "save-quick", "open-note", "bullet", "slash", "finish"],
  desktop: ["intro", "write", "hide-show", "save", "open-app", "app-here", "hotkey", "finish"],
} as const satisfies Record<GuideFlow, readonly string[]>;

export type GuideStep = (typeof STEPS)[GuideFlow][number];

/** The two kinds of window a guide is in: the quick note's (/quick), and the notes' (/app). */
export type GuideWindow = "quick" | "app";

export type GuideState = {
  flow: GuideFlow;
  step: GuideStep;
  /** When it came to this step: a guide left for long is over. */
  at: number;
  /** The window it was started in, which alone shows its first card. */
  startedIn?: GuideWindow;
  /** The step before was just done: said so above this one's words. */
  done?: boolean;
  /**
   * Asked for (「はじめの案内をもう一度見る」), not offered of itself: done,
   * it does not count as the computer's once (the desktop app's).
   */
  asked?: boolean;
};

/** Said in the page to start the guide again (the settings', 使い方's 「はじめの案内をもう一度見る」). */
export const SHOW_WELCOME = "memoca:show-welcome";

/** What the page tells the guide it has done, for the step waiting on it. */
export const GUIDE_DID = "memoca:guide-did";
export type GuideDid =
  | { what: "quick-saved"; noteId: string; windowed: boolean }
  | { what: "hotkey-set"; which: "quick" | "app" };

/** Told by the quick note as it saves, and the settings as a hotkey is changed. */
export function guideDid(detail: GuideDid): void {
  window.dispatchEvent(new CustomEvent<GuideDid>(GUIDE_DID, { detail }));
}

const KEY = "memoca:guide";
/** The desktop app's guide, done (or turned down) on this computer. */
const DESKTOP_DONE = "memoca:desktop-guide-done";
/** Left at a step for this long, a guide is over: not picked up a day later. */
export const STALE_MS = 30 * 60_000;
const CHANGED = "memoca:guide-changed";
const CHANNEL = "memoca-guide";

let channel: BroadcastChannel | null | undefined;
function opened(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  }
  return channel;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The guide as it is stored, as a string (what a snapshot compares): none
 * once left for long, so a card left up goes as its window is looked at again.
 */
export const storedGuide = (): string | null => {
  const raw = read(KEY);
  return guideFrom(raw) ? raw : null;
};

/** A guide left for long, taken out of storage. */
export function clearStaleGuide(): void {
  const raw = read(KEY);
  if (raw !== null && !guideFrom(raw)) setGuide(null);
}

let parsedFrom: string | null = null;
let parsed: GuideState | null = null;
/** The guide under way, if one is (and not left for long). */
export function guideFrom(raw: string | null, now = Date.now()): GuideState | null {
  if (raw !== parsedFrom) {
    parsedFrom = raw;
    try {
      const value = raw ? (JSON.parse(raw) as GuideState) : null;
      parsed =
        value && (STEPS[value.flow] as readonly string[] | undefined)?.includes(value.step) ? value : null;
    } catch {
      parsed = null;
    }
  }
  return parsed && now - parsed.at < STALE_MS ? parsed : null;
}

/** Puts the guide at a step (or ends it, null), here and in this device's other windows. */
export function setGuide(state: GuideState | null): void {
  try {
    if (state) localStorage.setItem(KEY, JSON.stringify(state));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage refused: the guide goes on in this window alone.
  }
  window.dispatchEvent(new Event(CHANGED));
  try {
    opened()?.postMessage("changed");
  } catch {
    // Closed as the page goes.
  }
}

/** The step after this one in its flow, or null after the last. */
export function nextStep(state: GuideState): GuideStep | null {
  const steps = STEPS[state.flow] as readonly GuideStep[];
  return steps[steps.indexOf(state.step) + 1] ?? null;
}

/**
 * Told of a change to the guide: from this window, another (its channel,
 * and storage), or this one coming into view, as it does as the desktop
 * app hands the guide from one of its windows to the other.
 */
export function subscribeGuide(onChange: () => void): () => void {
  const ch = opened();
  ch?.addEventListener("message", onChange);
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    ch?.removeEventListener("message", onChange);
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export const desktopGuideDone = () => read(DESKTOP_DONE) === "1";
export function rememberDesktopGuideDone(): void {
  try {
    localStorage.setItem(DESKTOP_DONE, "1");
  } catch {
    // Offered again here, at most.
  }
}
