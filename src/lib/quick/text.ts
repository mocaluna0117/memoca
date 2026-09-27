/**
 * The longest first line that becomes a quick note's title, in characters as
 * they are seen: about what a row of the note list shows on a phone. The
 * title field is a single line, so anything longer is better left in the
 * body, where all of it can be read.
 */
export const TITLE_LIMIT = 30;

/**
 * A link in a line: up to a space, or a closing bracket or punctuation mark
 * of Japanese text, which a link written into a sentence is followed by.
 */
const LINK = /https?:\/\/[^\s<>"'）」』】〕、。，．]+/i;

/** Marks a sentence ends a link with, not part of it. */
const TRAILING = /[.,!?。、，．！？)]+$/u;

/** The first link in a line, if there is one. */
function linkIn(line: string): string | null {
  const found = LINK.exec(line)?.[0].replace(TRAILING, "");
  return found || null;
}

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
 * What a share sheet or a shortcut puts in the quick note's address (the
 * manifest's share_target), taken out once read. The service worker keeps no
 * page loaded with any of them: Next writes the address into the page.
 */
export const SHARED = ["title", "text", "url"] as const;

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
 * that reads as a title (short, with no link in it, and not the start of a
 * list) becomes it and leaves the body, so the note does not open showing it
 * twice. Anything else stays whole in the body, where a link can be followed:
 * a first line with a link names the note after the link's site; a list has
 * no title; a first line too long for one names the note after the site of
 * a link further down, if there is one. Blank lines around the whole, and
 * between the title and the rest, are dropped.
 */
export function splitQuickText(text: string): { title: string; body: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blank = (line: string | undefined) => line !== undefined && line.trim() === "";
  while (blank(lines[0])) lines.shift();
  while (blank(lines.at(-1))) lines.pop();
  if (lines.length === 0) return { title: "", body: [] };

  const first = lines[0]!.trim();
  const link = linkIn(first);
  if (link) return { title: siteOf(link), body: lines };
  if (LIST_ITEM.test(first)) return { title: "", body: lines };
  if (characters(first).length > TITLE_LIMIT) {
    const further = lines.map(linkIn).find((found) => found !== null);
    return { title: further ? siteOf(further) : "", body: lines };
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
