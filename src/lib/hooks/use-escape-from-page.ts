"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Escape pressed with nothing focused, while `active`: `onEscape`.
 *
 * For what a list's own Escape stops (choosing notes), as that is heard only
 * from within the list. Safari, and Memoca for Mac in it, does not focus a
 * button it clicks: a click on one of the list's toolbar (すべて選択) leaves
 * nothing focused, and Escape then goes to the page, not the list. Not one
 * from anything focused, such as a dialog or a field, which are theirs.
 */
export function useEscapeFromPage(active: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  useLayoutEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      latest.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
}
