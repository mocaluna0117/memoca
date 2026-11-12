import { Kiwi_Maru, Nunito } from "next/font/google";

/** かわいい's letters (src/lib/look-fonts.ts): loaded only where the look is on, or shown. */
const kana = Kiwi_Maru({ variable: "--font-kiwi-maru", weight: ["400", "500"], preload: false, display: "swap" });
/** Its Latin letters, round as the kana are (Kiwi Maru's own are slab serifs). */
const latin = Nunito({
  variable: "--font-nunito",
  weight: ["400", "700"],
  subsets: ["latin"],
  preload: false,
  display: "swap",
});

export const font = { variable: `${latin.variable} ${kana.variable}` };
