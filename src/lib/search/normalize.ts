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
  return fold(input.normalize("NFKC").toLowerCase());
}

/** The folding after NFKC and lower case: katakana to hiragana, ー ・ 〜 dropped, a full-width space made a space. */
function fold(folded: string): string {
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

/** A character with the marks that go on it: a voicing mark after a half-width kana (ｶﾞ), a combining one. */
const CLUSTER = /[\s\S][\uFF9E\uFF9F\p{M}]*/gu;

/**
 * {@link normalize}, with where each character of the result came from in
 * `input`: `from[i]` and `to[i]` are the start and end, in `input`, of what
 * the result's character `i` was made of. The result is shorter or longer
 * than the text (ー and ・ are dropped, ｶﾞ is one が, ㍻ is 平成), so a match
 * found in it is not at the same place in the text: this says where it is.
 */
export function normalizeMapped(input: string): { text: string; from: number[]; to: number[] } {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  for (const match of input.matchAll(CLUSTER)) {
    const made = fold(match[0].normalize("NFKC").toLowerCase());
    for (let index = 0; index < made.length; index += 1) {
      from.push(match.index);
      to.push(match.index + match[0].length);
    }
    text += made;
  }
  return { text, from, to };
}

/** Splits a query into terms; every term must match (AND). */
export function terms(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 8);
}
