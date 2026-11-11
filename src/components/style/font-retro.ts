import { Klee_One } from "next/font/google";

/** レトロ's letters (src/lib/look-fonts.ts): loaded only where the look is on, or shown. */
export const font = Klee_One({ variable: "--font-klee", weight: ["400", "600"], preload: false, display: "swap" });
