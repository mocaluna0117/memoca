/**
 * Folds the differences Japanese text is written with, so a search for
 * "ぱんけーき" finds a note that says "パンケーキ" and "ｱｲﾃﾑ" matches "アイテム".
 *
 * - NFKC collapses half-width kana and full-width latin onto their normal forms
 * - katakana is folded to hiragana, which also makes the reverse work
 * - the long-vowel mark and the middle dot are dropped, because people are
 *   inconsistent about both
 */
export function normalize(input: string): string {
  const folded = input.normalize("NFKC").toLowerCase();
  let out = "";
  for (const char of folded) {
    const code = char.codePointAt(0)!;
    // Katakana block (excluding the long-vowel mark) shifted down to hiragana.
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCodePoint(code - 0x60);
      continue;
    }
    if (char === "ー" || char === "・" || char === "〜") continue;
    if (char === "　") {
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

/** Splits a query into terms; every term must match (AND). */
export function terms(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 8);
}
