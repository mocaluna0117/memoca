import type { BlockNoteEditor } from "@blocknote/core";

/**
 * A web address alone, as copied from a browser's address bar or a chat:
 * http(s), with no space in it. What follows it in a sentence (、。) is not
 * part of it, and such text is left to the ordinary paste.
 */
const ADDRESS = /^https?:\/\/[^\s<>"'、。「」]+$/i;

/** The address pasted, if what is pasted is one address and nothing else. */
export function pastedAddress(data: Pick<DataTransfer, "types" | "getData">): string | null {
  // Memoca's own copies are pasted as they were, links and all.
  if (data.types.includes("blocknote/html")) return null;
  const text = data.getData("text/plain").trim();
  if (!ADDRESS.test(text)) return null;
  // A page's own HTML with more than the link in it (a title, a picture)
  // is left to the ordinary paste, which keeps that too.
  const html = data.getData("text/html");
  if (html && stripped(html) !== text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

/** The text of some HTML, as a person would read it. */
function stripped(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").trim();
}

/**
 * A web address pasted: made a link. Over text selected, that text becomes
 * the link (as in a word processor); with nothing selected, the address goes
 * in as a link to itself. BlockNote's own does neither: its paste takes
 * every paste first, and pasted the address as plain text. False for
 * anything else, left to the next.
 */
export function pasteLink(event: ClipboardEvent, editor: BlockNoteEditor): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const address = pastedAddress(data);
  if (!address) return false;
  // Not in a code block, where an address is code.
  if (editor.getTextCursorPosition().block.type === "codeBlock") return false;
  const selected = editor.getSelectedText();
  editor.createLink(address, selected.length > 0 ? undefined : address);
  return true;
}
