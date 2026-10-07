"use client";

import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useEffect, useRef, useState } from "react";
import type { EditorView } from "prosemirror-view";
import { Button } from "@/components/ui/button";
import { endFind, findStatus, setFindQuery, stepFind } from "@/components/editor/find-in-note";

/**
 * Finding in the open note, as a browser's own find does in a page (which,
 * in Memoca for Mac, there is none of): opened by ⌘F (Ctrl+F) anywhere while
 * the note is open, with what is selected in it to look for. Enter goes to
 * the next match, Shift+Enter to the one before; Escape closes it, the match
 * on selected in the note.
 */
export function FindBar({ editor: note }: { editor: BlockNoteEditor }) {
  const view = () => note.prosemirrorView;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState({ count: 0, current: 0 });
  const field = useRef<HTMLInputElement>(null);
  const looking = useRef("");

  /** Looks for `next` in the note: the matches marked, the first scrolled to. */
  const look = (next: string) => {
    looking.current = next;
    setQuery(next);
    const editor = view();
    if (!editor) return;
    setFindQuery(editor, next);
    setStatus(findStatus(editor.state));
    scrollToCurrent(editor);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      const editor = view();
      if (!editor) return;
      event.preventDefault();
      const { from, to } = editor.state.selection;
      const selected = editor.state.doc.textBetween(from, to, " ");
      setOpen(true);
      look(selected && !selected.includes("\n") ? selected : looking.current);
      requestAnimationFrame(() => {
        field.current?.focus();
        field.current?.select();
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view reads the editor
  }, [note]);

  // How many there are, kept up as the note changes while it is open.
  useEffect(() => {
    if (!open) return;
    return note.onChange(() => {
      const editor = note.prosemirrorView;
      if (editor) setStatus(findStatus(editor.state));
    });
  }, [open, note]);

  const step = (direction: 1 | -1) => {
    const editor = view();
    if (!editor) return;
    stepFind(editor, direction);
    setStatus(findStatus(editor.state));
    scrollToCurrent(editor);
  };

  const close = (select: boolean) => {
    const editor = view();
    setOpen(false);
    if (!editor) return;
    endFind(editor, select);
    if (select) editor.focus();
  };

  if (!open) return null;
  return (
    // Over the note, not above it: of no height in it, so nothing moves down.
    <div className="sticky top-2 z-30 h-0">
      <div
        role="search"
        aria-label="メモ内を検索"
        className="absolute top-0 right-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-lg border bg-popover px-2 py-1 shadow-md"
      >
        <input
          ref={field}
          value={query}
          onChange={(event) => look(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            }
          }}
          placeholder="メモ内を検索"
          aria-label="メモ内を検索"
          className="w-44 min-w-0 bg-transparent px-1 text-sm outline-none"
        />
        <span
          className="min-w-14 text-right text-xs text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          {query ? (status.count > 0 ? `${status.current + 1} / ${status.count}` : "0 件") : ""}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="前へ"
          disabled={status.count === 0}
          onClick={() => step(-1)}
        >
          <ChevronUp className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="次へ"
          disabled={status.count === 0}
          onClick={() => step(1)}
        >
          <ChevronDown className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="閉じる"
          onClick={() => close(false)}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** The match on, scrolled to the middle of the screen once it is drawn. */
function scrollToCurrent(view: EditorView) {
  requestAnimationFrame(() => {
    view.dom.querySelector(".memoca-find-current")?.scrollIntoView({ block: "center" });
  });
}
