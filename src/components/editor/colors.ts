import { createStyleSpec } from "@blocknote/core";

/*
 * Colours of text, and behind it, in a note: none that Memoca shows or lets
 * be chosen. BlockNote took them from text pasted from elsewhere, as the
 * page had them (a page in dark mode: white text on near black), kept them
 * out of sight in the note, and wrote them out again, inline, with what was
 * copied from it: pasted into Gmail, lines came out white on black
 * (2026-11-19).
 */

const plainSpan = () => {
  const span = document.createElement("span");
  return { dom: span, contentDOM: span };
};

/**
 * BlockNote's colour of text and colour behind it, kept for notes that hold
 * them, but drawn, and copied out, as plain text: and read back only from
 * what Memoca copied (its data-style-type), never from the colours of text
 * pasted from elsewhere. As fontSize is.
 */
export const inertColorStyleSpecs = {
  textColor: createStyleSpec({ type: "textColor", propSchema: "string" }, { render: plainSpan }),
  backgroundColor: createStyleSpec({ type: "backgroundColor", propSchema: "string" }, { render: plainSpan }),
};

/** A colour, in a style: of text, or behind it (each part of a background). */
const isColour = (property: string) => property === "color" || property.startsWith("background");

/** BlockNote's own marks of a block's colours, which another BlockNote takes as colours. */
const BLOCK_COLOURS = ["data-background-color", "data-text-color"];

/**
 * HTML as copied out of a note for other apps, without colours: of text,
 * or behind a block or text. A block's colour (BlockNote's own, taken from
 * a pasted page as the text's was) is written inline too.
 */
export function withoutColors(html: string): string {
  if (!/color|background/i.test(html)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;
  for (const element of template.content.querySelectorAll<HTMLElement>("[style]")) {
    const colours = Array.from(element.style).filter(isColour);
    for (const property of colours) element.style.removeProperty(property);
    if (colours.length > 0) changed = true;
    if (!element.getAttribute("style")?.trim()) element.removeAttribute("style");
  }
  for (const element of template.content.querySelectorAll(BLOCK_COLOURS.map((name) => `[${name}]`).join(","))) {
    for (const name of BLOCK_COLOURS) element.removeAttribute(name);
    changed = true;
  }
  return changed ? template.innerHTML : html;
}
