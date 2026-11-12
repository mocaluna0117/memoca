"use client";

import type { StyleId } from "@/lib/style";

/**
 * The looks' own letters, each a font of a few hundred slices whose
 * stylesheet alone is some 180 KB: not in every page's, but loaded once a
 * page is in that look (or shows it, as the settings' choice does), and
 * then only the slices for the characters drawn. Until it has come, the
 * look's letters fall back to the platform's (globals.css).
 */
const LOADERS: Partial<Record<StyleId, () => Promise<{ font: { variable: string } }>>> = {
  cute: () => import("@/components/style/font-cute"),
  natural: () => import("@/components/style/font-natural"),
  retro: () => import("@/components/style/font-retro"),
  wafu: () => import("@/components/style/font-wafu"),
  pop: () => import("@/components/style/font-pop"),
  terminal: () => import("@/components/style/font-terminal"),
};

export function loadLookFont(style: StyleId): void {
  const load = LOADERS[style];
  if (!load) return;
  void load().then(
    // One class a font (かわいい's are two: its Latin letters, and its kana and kanji).
    ({ font }) => document.documentElement.classList.add(...font.variable.split(/\s+/).filter(Boolean)),
    () => undefined,
  );
}
