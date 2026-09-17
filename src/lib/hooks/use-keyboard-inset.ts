"use client";

import { useEffect, useState } from "react";

/**
 * How much of the window the on-screen keyboard is covering.
 *
 * `position: fixed` does not account for the software keyboard on iOS, so a
 * bar pinned to the bottom ends up underneath it. The visual viewport reports
 * the actually visible area, which is what the bar has to sit on.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(covered > 40 ? covered : 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
