"use client";

import type { BlockNoteEditor } from "@blocknote/core";
import { useEffect } from "react";
import { plainTextOf } from "@/lib/plain-text";

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
 */
export function usePlainTextCopy(editor: Pick<BlockNoteEditor, "domElement" | "prosemirrorView">) {
  useEffect(() => {
    let text: string | null = null;
    // The editor's element, where it is shown: none before it is, or after
    // (its view is then not to be touched).
    const inEditor = (event: Event) => {
      const shown = editor.domElement;
      return shown && event.target instanceof Node && shown.contains(event.target)
        ? editor.prosemirrorView
        : null;
    };
    const read = (event: Event) => {
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
      const { selection } = view.state;
      if (!selection.empty) text = plainTextOf(view.state.doc, selection);
    };
    const write = (event: ClipboardEvent) => {
      // The editor wrote the clipboard (and so stopped the browser's own copy).
      if (text && event.defaultPrevented) {
        // Windows' plain-text apps want CRLF, which the browser adds to a copy
        // of its own but not to one a page writes.
        const lines = /Windows/.test(navigator.userAgent) ? text.replace(/\n/g, "\r\n") : text;
        event.clipboardData?.setData("text/plain", lines);
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
