import { createExtension } from "@blocknote/core";

/**
 * Lists as Japanese is typed: ・ at the start of a line (the key where / is,
 * with the input method on) makes it a bullet list item, as - and a space
 * do in BlockNote. At once, with no space after it, which the input method
 * would take to change the ・ into something else. Backspace straight after
 * takes it back to the ・ typed. A heading stays a heading, as with -.
 */
export const japaneseLists = createExtension({
  key: "memocaJapaneseLists",
  inputRules: [
    {
      find: /^\s?[・･]$/,
      replace({ editor }) {
        const { block } = editor.getTextCursorPosition();
        if (block.type === "heading") return undefined;
        return { type: "bulletListItem", props: {} };
      },
    },
  ],
});
