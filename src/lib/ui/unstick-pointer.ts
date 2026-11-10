"use client";

/**
 * The page's clicks given back where something left them taken.
 *
 * Radix's modal layers (a dialog, an alert, a menu, a list to choose from)
 * take every click outside themselves while they are open, by setting the
 * page's body to `pointer-events: none`, and give them back as they go. Left
 * behind with no layer open (one opened from another as it went, the
 * desktop app's window put away and brought out with one open), nothing on
 * the page could be clicked, an image no more than a button, until the page
 * was loaded again.
 */

/** A layer open that takes the page's clicks for itself. */
const LAYERS = '[data-state="open"]:is([role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"])';

/** Whether a layer that takes the page's clicks for itself is open. */
export const layerOpen = (root: ParentNode = document) => root.querySelector(LAYERS) !== null;

/** Gives the page its clicks back, if they are taken with no layer open to take them. Whether it did. */
export function unstickPointer(): boolean {
  const body = document.body;
  if (!body || body.style.pointerEvents !== "none" || layerOpen()) return false;
  body.style.removeProperty("pointer-events");
  return true;
}

/**
 * Looks, and gives the clicks back if they are taken for nothing: as the
 * window is shown again or comes into focus, and as a click falls through
 * to the page's root (nothing on the page took it, as with them taken; the
 * next click is the page's). `onUnstuck` is told each time it does.
 */
export function watchStuckPointer(onUnstuck?: () => void): () => void {
  const check = () => {
    if (unstickPointer()) onUnstuck?.();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  const onDown = (event: PointerEvent) => {
    if (event.target === document.documentElement) check();
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("pointerdown", onDown, true);
  return () => {
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("pointerdown", onDown, true);
  };
}
