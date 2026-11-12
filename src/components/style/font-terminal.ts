import { BIZ_UDGothic } from "next/font/google";

/** ターミナル's Japanese letters, beside Geist Mono's (src/lib/look-fonts.ts): loaded only where the look is on, or shown. */
export const font = BIZ_UDGothic({ variable: "--font-biz-ud", weight: ["400", "700"], preload: false, display: "swap" });
