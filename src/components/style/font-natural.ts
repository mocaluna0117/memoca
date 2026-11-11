import { Zen_Kaku_Gothic_Antique } from "next/font/google";

/** ナチュラル's letters (src/lib/look-fonts.ts): loaded only where the look is on, or shown. */
export const font = Zen_Kaku_Gothic_Antique({
  variable: "--font-zen-kaku",
  weight: ["400", "700"],
  preload: false,
  display: "swap",
});
