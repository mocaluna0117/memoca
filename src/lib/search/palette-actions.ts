import { normalize } from "@/lib/search/normalize";

/** The command palette's actions, with the words each is found by. */
export const PALETTE_ACTIONS = {
  "quick-note": ["即席メモ", "そくせきめも", "quick"],
  "new-note": ["新しいメモ", "新規", "あたらしいめも", "しんき", "new", "note"],
  "new-folder": ["フォルダを追加", "新しいフォルダ", "ふぉるだ", "folder"],
  search: ["検索", "探す", "けんさく", "さがす", "search"],
  trash: ["ゴミ箱", "削除", "ごみばこ", "さくじょ", "trash"],
  settings: ["設定", "せってい", "settings"],
} as const;

export type PaletteAction = keyof typeof PALETTE_ACTIONS;

/**
 * The actions to offer for what was typed: all of them before anything is
 * typed, then only those a word of matches. Offered whatever was typed, the
 * first of them was picked by Enter when no note matched, or before the
 * notes found had come in: a search for a note opened the quick note.
 */
export function actionsFor(query: string): Set<PaletteAction> {
  const asked = normalize(query.trim());
  const names = Object.keys(PALETTE_ACTIONS) as PaletteAction[];
  if (!asked) return new Set(names);
  return new Set(
    names.filter((name) =>
      PALETTE_ACTIONS[name].some((word) => normalize(word).includes(asked)),
    ),
  );
}
