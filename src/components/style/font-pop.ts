import { M_PLUS_Rounded_1c } from "next/font/google";

/** ポップ's letters (src/lib/look-fonts.ts): loaded only where the look is on, or shown. */
export const font = M_PLUS_Rounded_1c({
  variable: "--font-mplus-rounded",
  weight: ["400", "800"],
  preload: false,
  display: "swap",
});
