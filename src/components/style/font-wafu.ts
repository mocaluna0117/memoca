import { Shippori_Mincho } from "next/font/google";

/** 和風's letters (src/lib/look-fonts.ts): loaded only where the look is on, or shown. */
export const font = Shippori_Mincho({
  variable: "--font-shippori",
  weight: ["400", "700"],
  preload: false,
  display: "swap",
});
