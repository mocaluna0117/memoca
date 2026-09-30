"use client";

import { type BlockNoteEditor, selectedFragmentToHTML } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { useEffect, useRef } from "react";
import {
  asPng,
  imageAlone,
  isWebKit,
  putImageOnClipboard,
  rememberImageCopy,
} from "@/components/editor/copy-image";
import { clipboardFor, copyRange, cutRange, isOpenOnScreen } from "@/components/editor/toggles";
import { plainTextBetween, plainTextOf } from "@/lib/plain-text";

/** Windows' plain-text apps want CRLF, which the browser adds to a copy of
 *  its own but not to one a page writes. */
const forThisSystem = (text: string) =>
  /Windows/.test(navigator.userAgent) ? text.replace(/\n/g, "\r\n") : text;

/**
 * Copying or cutting from a note gives apps that take plain text the text as
 * it reads (src/lib/plain-text.ts), in place of the Markdown BlockNote puts
 * there. What a note or a rich-text app pastes, BlockNote's HTML, is left as
 * it is.
 *
 * The text is read before the editor handles the event (on the way down),
 * which for a cut takes the selection away, and written after it (on the way
 * back up), over what it wrote. Listened for on the document: the editor's
 * view is made after this component's first render, and may be made again.
 *
 * An image copied alone is put on the clipboard as an image, for other apps
 * to paste, and known again when pasted back into Memoca (see copy-image.ts).
 *
 * A copy or cut of all of a closed toggle's line takes what is hidden inside
 * it too (see copyRange in toggles.ts): written here in full, BlockNote's
 * HTML included, and kept from the editor, which would take the line alone.
 */
export function usePlainTextCopy(
  editor: BlockNoteEditor,
  /** An image's bytes, by its url: for an image copied alone (see copy-image.ts). */
  loadImage?: (url: string) => Promise<Blob>,
) {
  const imageOf = useRef(loadImage);
  useEffect(() => {
    imageOf.current = loadImage;
  }, [loadImage]);
  useEffect(() => {
    let text: string | null = null;
    // Every copy and cut counts, in the note or not: an image made ready for
    // the clipboard after a later one has been made is not put there.
    let copies = 0;
    // The editor's element, where it is shown: none before it is, or after
    // (its view is then not to be touched).
    const inEditor = (event: Event) => {
      const shown = editor.domElement;
      return shown && event.target instanceof Node && shown.contains(event.target)
        ? editor.prosemirrorView
        : null;
    };
    const read = (event: Event) => {
      copies += 1;
      const view = inEditor(event);
      text = null;
      if (!view) return;
      // A selection made all at once (⌘A) may not have reached the editor
      // yet: without it, the editor leaves the copy to the browser, which
      // puts a blank line between every two blocks and drops list marks.
      // forceFlush first: flush alone waits while an input method is still
      // composing. Both are ProseMirror's own, not part of its public API.
      const observer = (
        view as unknown as { domObserver?: { forceFlush?: () => void; flush?: () => void } }
      ).domObserver;
      observer?.forceFlush?.();
      observer?.flush?.();
      const { selection, doc } = view.state;
      if (selection.empty) return;
      const toggle =
        selection instanceof TextSelection
          ? copyRange(doc, selection.from, selection.to, (block) => isOpenOnScreen(view, block))
          : null;
      const clipboard = (event as ClipboardEvent).clipboardData;
      if (toggle && clipboard) {
        const { clipboardHTML, externalHTML } = clipboardFor(editor, view, toggle);
        clipboard.clearData();
        clipboard.setData("blocknote/html", clipboardHTML);
        clipboard.setData("text/html", externalHTML);
        clipboard.setData(
          "text/plain",
          forThisSystem(plainTextBetween(doc, toggle.from, toggle.to)),
        );
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "cut" && view.editable) view.dispatch(cutRange(view.state, toggle));
        return;
      }
      text = plainTextOf(doc, selection);
      // An image alone: the image itself, for other apps, and the block as
      // Memoca copies it, to be pasted back as that.
      const url = event.type === "copy" ? imageAlone(doc, selection) : null;
      const load = imageOf.current;
      if (url && load) {
        const { clipboardHTML } = selectedFragmentToHTML(view, editor);
        const mine = copies;
        const image = load(url)
          .then(asPng)
          .then(({ png, width, height }) => {
            if (mine !== copies || !document.hasFocus()) throw new Error("overtaken");
            rememberImageCopy({ html: clipboardHTML, width, height });
            return png;
          });
        if (isWebKit()) {
          // WebKit refuses the image once the copy has written the clipboard:
          // the copy writes nothing, and the image is all it puts there.
          event.preventDefault();
          event.stopPropagation();
          text = null;
        }
        putImageOnClipboard(image);
      }
    };
    const write = (event: ClipboardEvent) => {
      // The editor wrote the clipboard (and so stopped the browser's own copy).
      // Empty too: an image alone gives no text, where BlockNote wrote Markdown for it.
      if (text !== null && event.defaultPrevented) {
        event.clipboardData?.setData("text/plain", forThisSystem(text));
      }
      text = null;
    };
    for (const kind of ["copy", "cut"] as const) {
      document.addEventListener(kind, read, true);
      document.addEventListener(kind, write);
    }
    return () => {
      for (const kind of ["copy", "cut"] as const) {
        document.removeEventListener(kind, read, true);
        document.removeEventListener(kind, write);
      }
    };
  }, [editor]);
}
