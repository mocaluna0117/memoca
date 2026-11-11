"use client";

/**
 * The app's welcome for someone new to it: a guide to do the most used
 * things by hand (components/onboarding/guide, lib/guide), and, for an
 * account just made, a note in its Inbox to try things in (lib/welcome-note,
 * loaded only then: it brings the editor's schema).
 */

/**
 * On this device, no welcome at all, nor a note to try things in: for the
 * tests, whose every run is a new account (e2e/helpers.ts), and anyone who
 * would rather not.
 */
export const WELCOME_OFF = "memoca:welcome-off";

/** Seen on this device by this account: not shown again while the server is still to hear of it. */
const seenKey = (userKey: string) => `memoca:welcome-seen:${userKey}`;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const welcomeOff = () => read(WELCOME_OFF) === "1";
export const welcomeSeenHere = (userKey: string) => read(seenKey(userKey)) === "1";
export function rememberWelcomeSeen(userKey: string): void {
  try {
    localStorage.setItem(seenKey(userKey), "1");
  } catch {
    // Shown again here only until the server has heard of it.
  }
}

/** The title of the note made to try things in. */
export const PRACTICE_TITLE = "はじめに読むメモ";
