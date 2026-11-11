import type { Transaction } from "prosemirror-state";

/** What is typed before the caret since the last space, in its line. */
function wordBefore(tr: Transaction): string {
  const { $from } = tr.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  return before.split(/\s/).pop() ?? "";
}

/**
 * Whether a character typed now begins a word: at the start of a line, or
 * after a space (a full-width one too). The emoji menu's ":" opens there
 * only: in a URL's "https:" it opened, and took the next Enter.
 */
export const atWordStart = (tr: Transaction) => wordBefore(tr) === "";

/**
 * The / menu: at the end of a word too (typed after a line's text, it makes
 * that line a heading or a list, see slash-turn-line), but not in what reads
 * as a URL or a path, a word with ":", "/" or "." in it ("https://example.com/a"),
 * nor after a number (a date's "11/30") or a letter ("A/B", "I/O", "w/o"):
 * opened there, it took the next Enter, choosing a block (B for a
 * subheading) and the text after "/" gone. And not in a table's cells, as
 * BlockNote's own is not.
 */
export function slashMenuOpens(tr: Transaction): boolean {
  if (tr.selection.$from.parent.type.isInGroup("tableContent")) return false;
  return !/[:/.]|[0-9A-Za-z]$/.test(wordBefore(tr));
}
