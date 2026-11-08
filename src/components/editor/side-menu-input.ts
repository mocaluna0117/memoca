import { createExtension } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { Plugin } from "prosemirror-state";

/**
 * A block's + and handle put away as soon as anything is typed, as
 * BlockNote puts them away on a key going down. Text that comes with no key
 * (a phone's suggestion taken, dictation, an input method's word on some
 * keyboards) left them shown, and with them shown, BlockNote looks for the
 * block under the pointer again with each change to the note: the browser
 * lays the page out first, every character.
 */
export const sideMenuAwayOnInput = createExtension(({ editor }) => {
  const away = () => {
    editor.getExtension(SideMenuExtension)?.hideMenuIfNotFrozen();
    return false;
  };
  return {
    key: "memocaSideMenuAwayOnInput",
    prosemirrorPlugins: [
      new Plugin({ props: { handleDOMEvents: { beforeinput: away, compositionstart: away } } }),
    ],
  };
});
