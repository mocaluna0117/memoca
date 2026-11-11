import { Zen_Maru_Gothic } from "next/font/google";

/** かわいい's letters (src/lib/look-fonts.ts): loaded only where the look is on, or shown. */
export const font = Zen_Maru_Gothic({
  variable: "--font-zen-maru",
  weight: ["400", "700"],
  preload: false,
  display: "swap",
});
