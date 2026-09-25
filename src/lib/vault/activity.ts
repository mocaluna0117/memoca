"use client";

import { vault } from "@/lib/crypto/vault";

/** Activity closer together than this counts once, to keep typing cheap. */
const TOUCH_EVERY_MS = 5_000;

/**
 * Keeps the vault open while the app is in use, and closes it on return if
 * its time ran out while the app was away.
 *
 * Returns a function that stops watching.
 */
export function watchVaultActivity(): () => void {
  let last = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - last < TOUCH_EVERY_MS) return;
    last = now;
    vault.touch();
  };
  const onReturn = () => {
    if (document.visibilityState === "visible") vault.checkDeadline();
  };

  const activity = ["pointerdown", "keydown", "input", "wheel", "touchstart"] as const;
  const options = { capture: true, passive: true } as const;
  for (const type of activity) window.addEventListener(type, onActivity, options);
  document.addEventListener("visibilitychange", onReturn);
  window.addEventListener("pageshow", onReturn);
  window.addEventListener("focus", onReturn);

  return () => {
    for (const type of activity) window.removeEventListener(type, onActivity, options);
    document.removeEventListener("visibilitychange", onReturn);
    window.removeEventListener("pageshow", onReturn);
    window.removeEventListener("focus", onReturn);
  };
}
