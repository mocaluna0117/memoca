"use client";

import { useEffect } from "react";
import { loadLookFont } from "@/lib/look-fonts";
import { STYLE_CHANGED, styleHere } from "@/lib/style";

/** The look's letters (lib/look-fonts), for the look the page is in, and each it is put in after. */
export function LookFonts() {
  useEffect(() => {
    const now = () => loadLookFont(styleHere());
    now();
    window.addEventListener(STYLE_CHANGED, now);
    return () => window.removeEventListener(STYLE_CHANGED, now);
  }, []);
  return null;
}
