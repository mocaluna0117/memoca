"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import type { BlockNoteEditor } from "@blocknote/core";
import { SuggestionMenu, filterSuggestionItems } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import {
  DesktopFormattingToolbarController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTheme } from "next-themes";
import { type Ref, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import { MemocaFormattingToolbar } from "@/components/editor/image-crop";
import { imeCommit } from "@/components/editor/ime-commit";
import { japaneseLists } from "@/components/editor/japanese-lists";
import { listKeys } from "@/components/editor/list-keys";
import { InlineBlockBar } from "@/components/editor/mobile-block-toolbar";
import { pasteLink } from "@/components/editor/paste-link";
import { DISABLED_EXTENSIONS, quoteShortcuts } from "@/components/editor/quotes";
import { DICTIONARY, SCHEMA } from "@/components/editor/schema";
import { turningLines } from "@/components/editor/slash-turn-line";
import { stuckToggles } from "@/components/editor/stuck-toggles";
import { toggles } from "@/components/editor/toggles";
import { openLinkApart } from "@/lib/open-link";
import { bodyFragment } from "@/lib/sync/ydoc";
import { t } from "@/lib/i18n/ja";

/** What the quick note does with its editor. */
export type QuickEditorHandle = {
  /** Into the editor: the caret where it was, or (`toEnd`) after what is written. */
  focus: (toEnd?: boolean) => void;
  /** Whether the caret is in it. */
  focused: () => boolean;
};

/**
 * The / menu's blocks that are a file: the quick note's images are added to
 * it apart (its strip of them), and go into the note under its text.
 */
const FILE_ITEMS = new Set(["image", "video", "audio", "file"]);

/** Both keys the save is on, for whatever keyboard: ⌘ on a Mac, Ctrl elsewhere. */
export const SAVE_KEYS = "Meta+Enter Control+Enter";

/**
 * The quick note's editor: a note's, on the tab's own document, with what
 * makes its lines lists, checks, toggles and headings (the / menu, `- ` and
 * the rest, Japanese input's too, and the toolbar over a selection), but no
 * file blocks, no links to notes and no + or handle beside a block. What it
 * holds is copied into the note as it is saved (lib/quick/body).
 *
 * Files pasted or dropped into it are handed to `onFiles`, for the strip of
 * images; ⌘ + Enter (Ctrl + Enter) is `onSave`, before anything of the
 * editor's own on those keys; and Esc, but for closing the / menu, is
 * `onEscape` where there is one (the editor's own takes the focus out of
 * it). On a phone, the bar of block actions goes into `barSlot`, at the
 * page's foot, above the keyboard.
 */
export function QuickEditor({
  doc,
  handle,
  onSave,
  onFiles,
  onEscape,
  barSlot,
  className,
}: {
  doc: Y.Doc;
  handle: Ref<QuickEditorHandle>;
  onSave: () => void;
  onFiles: (files: File[]) => void;
  /** Esc, the / menu not open: none, the editor's own. */
  onEscape?: () => void;
  /** Where the bar of block actions goes on a phone; none, no bar. */
  barSlot: HTMLElement | null;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  // Read when a file arrives: the editor keeps the options it was made with.
  const latest = useRef(onFiles);
  useLayoutEffect(() => {
    latest.current = onFiles;
  });
  const options = useMemo(
    () =>
      withCollaboration({
        collaboration: {
          fragment: bodyFragment(doc),
          // Nobody else edits it: undo and redo are Yjs's, nothing more.
          user: { name: "自分", color: "#0ea5e9" },
        },
        schema: SCHEMA,
        dictionary: {
          ...DICTIONARY,
          placeholders: { ...DICTIONARY.placeholders, emptyDocument: t.quick.placeholder },
        },
        // See note-editor: a first line's list marker is otherwise not drawn.
        animations: false,
        links: { onClick: (event: MouseEvent) => openLinkApart(event) },
        disableExtensions: DISABLED_EXTENSIONS,
        extensions: [japaneseLists, quoteShortcuts, listKeys(), toggles(), stuckToggles, imeCommit()],
        domAttributes: {
          editor: { "aria-label": t.quick.field, "aria-keyshortcuts": SAVE_KEYS },
        },
        // Files to the strip of images; text, with them or not, into the
        // editor (an image copied from a page comes with its address).
        pasteHandler: ({ event, editor: pasting, defaultPasteHandler }) => {
          const data = event.clipboardData;
          const files = data ? [...data.files] : [];
          if (files.length > 0) {
            latest.current(files);
            if (!data?.types.includes("text/plain")) return true;
          }
          return pasteLink(event, pasting as unknown as BlockNoteEditor) || defaultPasteHandler();
        },
      }),
    [doc],
  );
  const editor = useCreateBlockNote(options, [doc]);
  // As Memoca's own parts take it: they need none of the columns' types.
  const plain = editor as unknown as BlockNoteEditor;

  useImperativeHandle(
    handle,
    () => ({
      focus: (toEnd = false) => {
        if (toEnd) {
          const last = editor.document.at(-1);
          if (last) {
            try {
              editor.setTextCursorPosition(last, "end");
            } catch {
              // A block with no line of text (a table): left where it is.
            }
          }
        }
        editor.focus();
      },
      focused: () => editor.prosemirrorView?.hasFocus() ?? false,
    }),
    [editor],
  );

  return (
    <div
      className={className}
      onKeyDownCapture={(event) => {
        const native = event.nativeEvent;
        if (native.isComposing || native.keyCode === 229) return;
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          // Not a toggle's ⌘ + Enter, nor anything else of the editor's.
          event.preventDefault();
          event.stopPropagation();
          onSave();
        } else if (
          event.key === "Escape" &&
          onEscape &&
          !editor.getExtension(SuggestionMenu)?.shown()
        ) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
      onDragOverCapture={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDropCapture={(event) => {
        const files = [...event.dataTransfer.files];
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        onFiles(files);
      }}
    >
      <BlockNoteView
        editor={editor}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        className="memoca-editor memoca-quick-editor"
        formattingToolbar={false}
        slashMenu={false}
        sideMenu={false}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          shouldOpen={(state) => !state.selection.$from.parent.type.isInGroup("tableContent")}
          getItems={async (query) =>
            filterSuggestionItems(
              turningLines(plain, getDefaultReactSlashMenuItems(editor)).filter(
                (item) => !FILE_ITEMS.has((item as { key?: string }).key ?? ""),
              ),
              query,
            )
          }
        />
        <DesktopFormattingToolbarController formattingToolbar={MemocaFormattingToolbar} />
        {barSlot ? createPortal(<InlineBlockBar />, barSlot) : null}
      </BlockNoteView>
    </div>
  );
}
