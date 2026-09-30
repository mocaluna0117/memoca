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
 * The lines of the body, as typed: all of it, the first line too (a quick
 * note has no title; its first line stands in for one where notes are
 * listed, src/lib/note-name.ts). Blank lines around the whole are dropped.
 */
export function quickLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blank = (line: string | undefined) => line !== undefined && line.trim() === "";
  while (blank(lines[0])) lines.shift();
  while (blank(lines.at(-1))) lines.pop();
  return lines;
}
