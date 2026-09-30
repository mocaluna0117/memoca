/**
 * How a stand-in is set apart from a title given: lighter, and not bold,
 * yet dark enough to read on a selected row (4.5:1 and more).
 */
export const STAND_IN_CLASS = "font-normal text-foreground/70";

/** What a note with neither a title nor a line of text is called. */
export const UNTITLED = "無題のメモ";

/** The characters of a text as they are seen: a family emoji or a flag is one. */
function characters(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text);
    return Array.from(graphemes, (grapheme) => grapheme.segment);
  }
  return Array.from(text);
}

/**
 * The first line of a text with anything on it, trimmed, up to `limit`
 * characters as they are seen (a family emoji or a flag is not cut apart).
 */
export function firstLineOf(text: string, limit: number): string {
  const line = text.split("\n").find((found) => found.trim().length > 0) ?? "";
  return characters(line.trim()).slice(0, limit).join("");
}

/** How many characters of a first line stand in for a title. */
const STAND_IN_LIMIT = 60;

/** What a note is called where it is listed. */
export type NoteName = {
  text: string;
  /** Not a title given: the first line of its text, or 無題のメモ. */
  standIn: boolean;
  /** Neither a title nor a line of text: 無題のメモ. */
  untitled: boolean;
};

/**
 * What a note is called where it is listed: its title; with none, the first
 * line of its text (its preview), standing in for one, as it does for a
 * quick note (which keeps all of what is written in the body); with
 * neither, 無題のメモ. A stand-in is shown as one, set apart from a title
 * given.
 */
export function noteName(
  title: string | null | undefined,
  firstLine: string | null | undefined,
): NoteName {
  const given = title?.trim();
  if (given) return { text: given, standIn: false, untitled: false };
  const line = firstLine ? firstLineOf(firstLine, STAND_IN_LIMIT) : "";
  return line
    ? { text: line, standIn: true, untitled: false }
    : { text: UNTITLED, standIn: true, untitled: true };
}
