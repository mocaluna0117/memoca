"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import type { BlockNoteEditor } from "@blocknote/core";
import { SuggestionMenu, filterSuggestionItems } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import {
  DesktopFormattingToolbarController,
  GridSuggestionMenuController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTheme } from "next-themes";
import {
  type Ref,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { atWordStart, slashMenuOpens } from "@/components/editor/menu-start";
import { paintFrame, settleRefusedBlock, showUploadPreview } from "@/components/editor/upload-preview";
import type * as Y from "yjs";
import { MemocaFormattingToolbar } from "@/components/editor/image-crop";
import { imeCommit } from "@/components/editor/ime-commit";
import { japaneseLists } from "@/components/editor/japanese-lists";
import { usePlainTextCopy } from "@/components/editor/plain-copy";
import { type LinesAnchor, type LinesTaken, linesForTodo, putBackLines, removeLines } from "@/lib/quick/move-lines";
import { listKeys } from "@/components/editor/list-keys";
import { InlineBlockBar } from "@/components/editor/mobile-block-toolbar";
import { pasteLink } from "@/components/editor/paste-link";
import { DISABLED_EXTENSIONS, quoteShortcuts } from "@/components/editor/quotes";
import { DICTIONARY, SCHEMA } from "@/components/editor/schema";
import { turningLines } from "@/components/editor/slash-turn-line";
import { stuckToggles } from "@/components/editor/stuck-toggles";
import { toggles } from "@/components/editor/toggles";
import { openLinkApart } from "@/lib/open-link";
import { SAVE_KEYS } from "@/lib/quick/keys";
import { bodyFragment } from "@/lib/sync/ydoc";
import { t } from "@/lib/i18n/ja";

/** What the quick note does with its editor. */
export type QuickEditorHandle = {
  /** Into the editor: the caret where it was, or (`toEnd`) after what is written. */
  focus: (toEnd?: boolean) => void;
  /** Whether the caret is in it. */
  focused: () => boolean;
  /**
   * The lines to move into the Todo: those the selection is in, or, with
   * none selected (the caret alone), all of them; and whether that is all.
   */
  linesForTodo: () => LinesTaken;
  /** Takes these blocks out, as an edit of the editor's own (⌘ + Z puts them back). */
  remove: (ids: string[]) => void;
  /** Puts blocks back where they were taken from. */
  putBack: (blocks: Block[], anchor: LinesAnchor) => void;
  /** Images (chosen by the button) put in where the caret is, each made ready as one pasted is. */
  insertImages: (files: File[]) => void;
};

/**
 * What the quick note does with its images, there being no note yet for
 * them to go up into: makes a file ready (or turns it away, saying why),
 * keeping it in the tab's draft, and gives the reference its block shows
 * it by (lib/quick/body quickImageRef); and gives what shows one.
 */
export type QuickImages = {
  /** Files are coming in (a paste, a drop, the button): what was said of those before is over. */
  begin: () => void;
  prepare: (file: File, blockId?: string) => Promise<string>;
  shown: (ref: string) => Promise<string>;
};

/** A block of the quick note's, as BlockNote gives one. */
type Block = BlockNoteEditor["document"][number];

/**
 * The / menu's blocks that are a file: the quick note's images come in by
 * a paste, a drop or its button, and nothing else goes up from it.
 */
const FILE_ITEMS = new Set(["image", "video", "audio", "file"]);

/**
 * The quick note's editor: a note's, on the tab's own document, with what
 * makes its lines lists, checks, toggles and headings (the / menu, `- ` and
 * the rest, Japanese input's too, and the toolbar over a selection), but no
 * file blocks, no links to notes and no + or handle beside a block. What it
 * holds is copied into the note as it is saved (lib/quick/body).
 *
 * An image pasted or dropped into it goes in where it was put, as into a
 * note: shown at once, dimmed, while `images` makes it ready, and then as
 * it is; a file turned away leaves no block. ⌘ + Enter (Ctrl + Enter) is `onSave`, before anything of the
 * editor's own on those keys; and Esc, but for closing the / menu, is
 * `onEscape` where there is one (the editor's own takes the focus out of
 * it). On a phone, the bar of block actions goes into `barSlot`, at the
 * page's foot, above the keyboard.
 */
export const QuickEditor = memo(function QuickEditor({
  doc,
  handle,
  onSave,
  images,
  onEscape,
  barSlot,
  autoFocus = false,
  className,
}: {
  doc: Y.Doc;
  handle: Ref<QuickEditorHandle>;
  onSave: () => void;
  images: QuickImages;
  /** Esc, the / menu not open: none, the editor's own. */
  onEscape?: () => void;
  /** Where the bar of block actions goes on a phone; none, no bar. */
  barSlot: HTMLElement | null;
  /** Into it as it is shown, after what is written. */
  autoFocus?: boolean;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  // Read when a file arrives, or an image is shown: the editor keeps the
  // options it was made with.
  const latest = useRef(images);
  useLayoutEffect(() => {
    latest.current = images;
  });
  const editorRef = useRef<BlockNoteEditor | null>(null);
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
        extensions: [
          japaneseLists,
          quoteShortcuts,
          listKeys(),
          toggles(),
          stuckToggles,
          imeCommit(),
        ],
        domAttributes: {
          editor: { "aria-label": t.quick.field, "aria-keyshortcuts": SAVE_KEYS },
        },
        // An image where it is put, made ready by the quick note (see
        // QuickImages): BlockNote shows it loading meanwhile, and the
        // original, dimmed, over that (showUploadPreview).
        uploadFile: async (file: File, blockId?: string) => {
          const release = showUploadPreview(editorRef.current, blockId, file);
          try {
            await paintFrame();
            return await latest.current.prepare(file, blockId);
          } catch (error) {
            settleRefusedBlock(editorRef.current, blockId, file);
            throw error;
          } finally {
            release();
          }
        },
        resolveFileUrl: (url: string) => latest.current.shown(url),
        // Files where they are pasted, as into a note (BlockNote's own, with
        // the upload above); text into the editor, a link as one.
        pasteHandler: ({ event, editor: pasting, defaultPasteHandler }) => {
          if ((event.clipboardData?.files.length ?? 0) > 0) {
            latest.current.begin();
            return defaultPasteHandler();
          }
          return pasteLink(event, pasting as unknown as BlockNoteEditor) || defaultPasteHandler();
        },
      }),
    [doc],
  );
  const editor = useCreateBlockNote(options, [doc]);
  // As Memoca's own parts take it: they need none of the columns' types.
  const plain = editor as unknown as BlockNoteEditor;
  // Copied, the lines as they read, as from a note: BlockNote's own plain
  // text is Markdown, a blank line between every two lines.
  usePlainTextCopy(plain);
  useLayoutEffect(() => {
    editorRef.current = plain;
  }, [plain]);
  /**
   * Images put in where the caret is, one after another (in its line, if it
   * is empty, or after it), each made ready as one pasted is: BlockNote's
   * own upload, which shows it loading.
   */
  const insertImages = useCallback(
    async (files: File[]) => {
      latest.current.begin();
      let at: { id: string; type: string; content?: unknown } = plain.getTextCursorPosition().block;
      for (const file of files) {
        const block = { type: "image", props: { name: file.name } } as never;
        const empty = at.type === "paragraph" && Array.isArray(at.content) && at.content.length === 0;
        const made = empty
          ? plain.replaceBlocks([at.id], [block]).insertedBlocks[0]
          : plain.insertBlocks([block], at.id, "after")[0];
        if (!made) return;
        at = made;
        try {
          const url = await plain.uploadFile!(file, made.id);
          plain.updateBlock(made.id, { props: { url: url as string, name: file.name } } as never);
        } catch {
          // Turned away: said, and its block put right (see uploadFile).
        }
      }
    },
    [plain],
  );

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
      linesForTodo: () => linesForTodo(plain),
      remove: (ids) => removeLines(plain, ids),
      putBack: (blocks, anchor) => putBackLines(plain, blocks, anchor),
      insertImages: (files) => void insertImages(files),
    }),
    [editor, plain, insertImages],
  );

  // Shown: ready to type into, after what is written.
  useEffect(() => {
    if (!autoFocus) return;
    const last = editor.document.at(-1);
    if (last) {
      try {
        editor.setTextCursorPosition(last, "end");
      } catch {
        // A block with no line of text (a table): left where it is.
      }
    }
    editor.focus();
    // As it is first shown only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        // Into the editor's own text: BlockNote's, where it is dropped.
        // Beside it (its margins): where the caret is, not opened as a page.
        const files = [...event.dataTransfer.files];
        if (files.length === 0) return;
        if ((event.target as HTMLElement).closest?.(".ProseMirror")) {
          latest.current.begin();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void insertImages(files);
      }}
    >
      <BlockNoteView
        editor={editor}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        className="memoca-editor memoca-quick-editor"
        formattingToolbar={false}
        slashMenu={false}
        sideMenu={false}
        emojiPicker={false}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          shouldOpen={slashMenuOpens}
          getItems={async (query) =>
            filterSuggestionItems(
              turningLines(plain, getDefaultReactSlashMenuItems(editor)).filter(
                (item) => !FILE_ITEMS.has((item as { key?: string }).key ?? ""),
              ),
              query,
            )
          }
        />
        {/* BlockNote's emoji menu (":" and a word), at a word's start only. */}
        <GridSuggestionMenuController triggerCharacter=":" columns={10} minQueryLength={2} shouldOpen={atWordStart} />
        <DesktopFormattingToolbarController formattingToolbar={MemocaFormattingToolbar} />
        {barSlot ? createPortal(<InlineBlockBar />, barSlot) : null}
      </BlockNoteView>
    </div>
  );
});
