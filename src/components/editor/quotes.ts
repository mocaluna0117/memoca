import { createExtension } from "@blocknote/core";

/**
 * BlockNote's own quote shortcuts, left out of the editor (see
 * {@link quoteShortcuts}): among them, any quotation mark and a space at
 * the start of a line makes a quote, by which a line of Japanese beginning
 * with 「 (as speech does) became one as soon as a space was typed.
 */
export const DISABLED_EXTENSIONS = ["quote-block-shortcuts"];

/**
 * The quote shortcuts kept: > and a space at the start of a line, and
 * ⌘⌥Q (Ctrl+Alt+Q), as BlockNote has them. Not a quotation mark and a
 * space: 「, 『, " or ' begin ordinary lines.
 */
export const quoteShortcuts = createExtension({
  key: "memocaQuotes",
  keyboardShortcuts: {
    "Mod-Alt-q": ({ editor }) => {
      const { block } = editor.getTextCursorPosition();
      const spec = (editor.schema.blockSchema as Record<string, { content: string }>)[block.type];
      if (spec?.content !== "inline") return false;
      editor.updateBlock(block, { type: "quote", props: {} });
      return true;
    },
  },
  inputRules: [
    {
      find: /^>\s$/,
      replace() {
        return { type: "quote", props: {} };
      },
    },
  ],
});
