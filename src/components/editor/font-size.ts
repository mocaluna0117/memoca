import { createStyleSpec } from "@blocknote/core";

/**
 * The sizes text can be made, beyond the size it is: as a part of the size
 * of what it is in, so that a heading's text is made larger or smaller from
 * the heading's size.
 */
export const FONT_SIZES = [
  { value: "0.8em", label: "小" },
  { value: null, label: "標準" },
  { value: "1.25em", label: "大" },
  { value: "1.5em", label: "特大" },
] as const;

const SIZES = new Set<string>(FONT_SIZES.flatMap(({ value }) => (value ? [value] : [])));

/**
 * A size given to some text, chosen from the toolbar's 文字の大きさ.
 *
 * A style of its own in the note: an earlier version, with no such style,
 * would once have taken the text out of the note, and since keeps it as it
 * is, its size left out (patches/y-prosemirror). Only a size of
 * {@link FONT_SIZES} is drawn. Read back from what Memoca copied, never
 * from text pasted from elsewhere, where every piece of text has a size.
 */
export const fontSize = createStyleSpec(
  { type: "fontSize", propSchema: "string" },
  {
    render: (value) => {
      const span = document.createElement("span");
      if (value && SIZES.has(value)) span.style.fontSize = value;
      return { dom: span, contentDOM: span };
    },
  },
);
