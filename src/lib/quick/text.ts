/**
 * The longest first line that becomes a quick note's title, in characters as
 * they are seen: about what a row of the note list shows on a phone. The
 * title field is a single line, so anything longer is better left in the
 * body, where all of it can be read.
 */
export const TITLE_LIMIT = 30;

/** A line that is only a link: kept in the body, where it can be followed. */
const LINK_ONLY = /^https?:\/\/\S+$/i;

/** A line that begins as an item of a list does: kept with the rest of the list. */
const LIST_ITEM = /^(?:[・•●○◦■□▪▫☐☑✓✔]|[-*+]\s|\d{1,3}[.)．]\s|[①-⑳])/u;

/** The characters of a text as they are seen: a family emoji or a flag is one. */
function characters(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text);
    return Array.from(graphemes, (grapheme) => grapheme.segment);
  }
  return Array.from(text);
}

/**
 * What a share sheet or a shortcut sent, as one text, without saying
 * anything twice: the title on the first line, then the text, then the link.
 * The title is left out only where the text begins with it, as a line of its
 * own or before a space (then just that beginning goes); the link only where
 * the text or the title already holds it, as a word of its own.
 */
export function joinShared(parts: {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}): string {
  const title = parts.title?.trim() ?? "";
  let text = parts.text?.trim() ?? "";
  const url = parts.url?.trim() ?? "";
  const next = text.charAt(title.length);
  if (title && text.startsWith(title) && (next === "" || /\s/.test(next))) {
    text = text.slice(title.length).trim();
  }
  const lines = [title, text].filter(Boolean);
  const holds = (line: string) => line.split(/\s+/).includes(url);
  if (url && !lines.some(holds)) lines.push(url);
  return lines.join("\n");
}

/**
 * Splits what was typed into a title and the lines of the body. A first line
 * that reads as a title (short, and not a link or the start of a list)
 * becomes it and leaves the body, so the note does not open showing it twice.
 * Anything else stays whole in the body, with no title; a note that begins
 * with a link is named after the link's site. Blank lines around the whole,
 * and between the title and the rest, are dropped.
 */
export function splitQuickText(text: string): { title: string; body: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blank = (line: string | undefined) => line !== undefined && line.trim() === "";
  while (blank(lines[0])) lines.shift();
  while (blank(lines.at(-1))) lines.pop();
  if (lines.length === 0) return { title: "", body: [] };

  const first = lines[0]!.trim();
  if (LINK_ONLY.test(first)) return { title: siteOf(first), body: lines };
  if (LIST_ITEM.test(first) || characters(first).length > TITLE_LIMIT) {
    return { title: "", body: lines };
  }
  const body = lines.slice(1);
  while (blank(body[0])) body.shift();
  return { title: first, body };
}

/** The site a link points to, as a title: its host, without "www.". */
function siteOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
