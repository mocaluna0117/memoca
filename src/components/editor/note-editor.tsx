"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import { type BlockNoteEditor, combineByGroup } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import {
  DesktopFormattingToolbarController,
  type FloatingUIOptions,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
  useEditorState,
} from "@blocknote/react";
import { flip, offset, shift } from "@floating-ui/react";
import { NodeSelection } from "prosemirror-state";
import { getMultiColumnSlashMenuItems } from "@blocknote/xl-multi-column";
import { BlockNoteView } from "@blocknote/shadcn";
import { useConvex } from "convex/react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type * as Y from "yjs";
import { useSync } from "@/components/providers/sync-provider";
import {
  ImageCrop,
  MemocaFormattingToolbar,
  ToolbarOnImageTap,
} from "@/components/editor/image-crop";
import { MobileBlockToolbar } from "@/components/editor/mobile-block-toolbar";
import { useRelockCopies } from "@/components/editor/use-relock-copies";
import { Skeleton } from "@/components/ui/skeleton";
import { vault } from "@/lib/crypto/vault";
import {
  idFromRef,
  loadAttachmentBlob,
  prepareUpload,
  resolveAttachment,
  stageUpload,
} from "@/lib/media/attachments";
import { uploadRefusal } from "@/lib/media/refusal";
import { warmWebpEncoder } from "@/lib/media/webp-encoder";
import { openLinkApart } from "@/lib/open-link";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";
import { usePlainTextCopy } from "@/components/editor/plain-copy";
import { pasteOwnImage } from "@/components/editor/copy-image";
import { dragHandle } from "@/components/editor/drag-handle";
import { fromTitle, linesAbove } from "@/components/editor/line-above";
import { selectMedia } from "@/components/editor/select-media";
import { onTitleEnter } from "@/components/editor/title-enter";
import { stuckToggles } from "@/components/editor/stuck-toggles";
import { computeDropPosition, toggles } from "@/components/editor/toggles";
import { japaneseLists } from "@/components/editor/japanese-lists";
import { DICTIONARY, SCHEMA } from "@/components/editor/schema";
import { LayoutTemplate } from "lucide-react";
import { db } from "@/lib/db";
import { t } from "@/lib/i18n/ja";
import { noteName } from "@/lib/note-name";
import { TEMPLATES_FOLDER_ID, TemplateUnavailableError, insertTemplate, isTemplate } from "@/lib/templates";

/** Blocks that are a file, shown as one: an image, a video, a sound, a PDF or any file. */
const MEDIA = new Set(["image", "video", "audio", "file"]);

/**
 * The toolbar of an image, a video or a file selected: inside it, along its
 * top, rather than above it, where it covered the line before it (an image
 * pasted is selected, and has its toolbar, at once). Above it, as for text,
 * when it is not twice as tall as the toolbar (a file shown by its name, a
 * small image): inside, it would hide what it is for.
 */
const OVER_MEDIA: FloatingUIOptions = {
  useFloatingOptions: {
    middleware: [
      offset(({ rects }) =>
        rects.reference.height >= rects.floating.height * 2 + 16 ? -rects.floating.height - 8 : 10,
      ),
      shift(),
      flip(),
    ],
  },
};

/** A link clicked in a note opens apart from the app's window (see openLinkApart). */
const LINKS = { onClick: (event: MouseEvent) => openLinkApart(event) };

/**
 * Puts right the block a refused file leaves. BlockNote makes one before the
 * file is handed over (for a paste or a drop), or uses the empty one the
 * person picked a file for, and in either case shows it loading until a file
 * arrives, which now never happens. One made for this file becomes the empty
 * line it was made from; the person's own goes back to its button, to try
 * again. A file that was to replace another leaves that one as it was.
 */
function settleRefusedBlock(editor: BlockNoteEditor | null, blockId: string | undefined, file: File) {
  const block = editor && blockId ? editor.getBlock(blockId) : undefined;
  if (!editor || !block) return;
  const props = block.props as { url?: string; name?: string };
  if (props.url) return;
  const fresh = props.name === file.name ? { type: "paragraph" } : { type: block.type };
  try {
    editor.replaceBlocks([block.id], [fresh as never]);
  } catch {
    // Gone meanwhile: nothing left to put right.
  }
}

/**
 * The note body.
 *
 * BlockNote edits the Yjs document directly, and the document manager turns
 * those changes into update rows and outbox entries. Nothing here talks to the
 * network, which is why typing works the same with or without one.
 */
export function NoteEditor({
  noteId,
  locked,
  readOnly = false,
}: {
  noteId: string;
  locked: boolean;
  readOnly?: boolean;
}) {
  // The loaded document is tagged with the note it belongs to, so a slow load
  // for a note the user has already navigated away from cannot be shown.
  const [loaded, setLoaded] = useState<{ noteId: string; doc: Y.Doc } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void acquireDoc(noteId).then(
      (doc) => {
        if (cancelled) void releaseDoc(noteId);
        else setLoaded({ noteId, doc });
      },
      // A locked note whose key this vault cannot open. Say so instead of
      // showing a skeleton forever.
      () => {
        if (!cancelled) setFailed(noteId);
      },
    );
    return () => {
      cancelled = true;
      void releaseDoc(noteId);
    };
  }, [noteId]);

  const doc = loaded?.noteId === noteId ? loaded.doc : null;

  if (locked && !vault.isUnlocked) return null;
  if (failed === noteId) {
    return (
      <p role="alert" className="text-muted-foreground px-4 py-6 text-sm sm:px-10">
        このメモを開けませんでした。金庫の鍵が合わない可能性があります。
      </p>
    );
  }
  if (!doc) {
    return (
      <div className="space-y-3 px-4 py-6 sm:px-10">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }
  return <EditorSurface key={noteId} noteId={noteId} doc={doc} locked={locked} readOnly={readOnly} />;
}

function EditorSurface({
  noteId,
  doc,
  locked,
  readOnly,
}: {
  noteId: string;
  doc: Y.Doc;
  locked: boolean;
  readOnly: boolean;
}) {
  const client = useConvex();
  const { me } = useSync();
  const { resolvedTheme } = useTheme();
  // Read when a file arrives: BlockNote keeps the uploadFile it was made with,
  // so what that sees has to be looked up, not remembered.
  const latest = useRef({ me, locked });
  useEffect(() => {
    latest.current = { me, locked };
  }, [me, locked]);
  const editorRef = useRef<BlockNoteEditor | null>(null);
  // Where the canvas cannot write WebP, the encoder is fetched while there is
  // a network, ready for the first image.
  useEffect(() => {
    void warmWebpEncoder();
  }, []);

  const uploadFile = useCallback(
    async (file: File, blockId?: string) => {
      const { me: figures, locked: lockedNow } = latest.current;
      try {
        // Checked before it is staged: a refusal later happens in the
        // background, with nobody to tell.
        const prepared = await prepareUpload(file, figures, { locked: lockedNow });
        return await stageUpload({ noteId, file, locked: lockedNow, prepared });
      } catch (error) {
        toast.error(uploadRefusal(error));
        settleRefusedBlock(editorRef.current, blockId, file);
        throw error;
      }
    },
    [noteId],
  );

  const resolveFileUrl = useCallback(
    async (url: string) => {
      const id = idFromRef(url);
      if (!id) return url;
      return (await resolveAttachment(client, id)) ?? url;
    },
    [client],
  );

  const options = useMemo(
    () =>
      // uploadFile reads its refs when a file arrives, never while rendering:
      // BlockNote only calls it for a paste, a drop or the file panel.
      // eslint-disable-next-line react-hooks/refs
      withCollaboration({
        collaboration: {
          fragment: bodyFragment(doc),
          // Single-user app: no provider means no awareness traffic and no
          // remote cursors, but undo/redo stays Yjs-aware.
          user: { name: me?.name ?? "自分", color: "#0ea5e9" },
        },
        schema: SCHEMA,
        dictionary: DICTIONARY,
        // BlockNote's animations mark a block whose type just changed with
        // what it was (data-prev-type), and its list markers are drawn only
        // where that mark is absent or says the same. Every note opens with
        // its first block seen to change, from the empty line a new editor
        // starts with (both are initialBlockId), and the mark, if it is not
        // taken off, leaves a first bullet with no • until the next edit.
        animations: false,
        uploadFile,
        resolveFileUrl,
        links: LINKS,
        extensions: [
          japaneseLists,
          toggles(),
          stuckToggles,
          dragHandle,
          selectMedia(),
          linesAbove(),
        ],
        dropCursor: { hooks: { computeDropPosition } },
        // An image Memoca copied alone, pasted back as the block it was.
        pasteHandler: ({ event, editor: pasting, defaultPasteHandler }) =>
          pasteOwnImage(event, pasting as unknown as BlockNoteEditor) || defaultPasteHandler(),
      }),
    [doc, me?.name, uploadFile, resolveFileUrl],
  );

  const editor = useCreateBlockNote(options, [doc]);
  /** Each template, for the / menu: put where the caret is. Not this note itself. */
  const templateItems = async () => {
    const templates = (await db().notes.where("folderId").equals(TEMPLATES_FOLDER_ID).toArray())
      .filter((note) => isTemplate(note) && note.noteId !== noteId)
      .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "ja"));
    return templates.map((template) => {
      const name = noteName(template.title, template.preview).text;
      return {
        title: name,
        subtext: t.templates.slashSubtext,
        aliases: ["テンプレート", "template", "てんぷれーと"],
        group: t.templates.slashGroup,
        icon: <LayoutTemplate size={18} />,
        onItemClick: () => {
          insertTemplate(editor, template.noteId).catch((error: unknown) =>
            toast.error(
              error instanceof TemplateUnavailableError ? t.templates.unavailable : "テンプレートを使えませんでした。",
            ),
          );
        },
      };
    });
  };
  const mediaSelected = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { selection } = current.prosemirrorState;
      if (!(selection instanceof NodeSelection)) return false;
      const { node } = selection;
      return MEDIA.has(node.type.name) || MEDIA.has(node.firstChild?.type.name ?? "");
    },
  });
  // As Memoca's own parts take it: they need none of the columns' types.
  const plain = editor as unknown as BlockNoteEditor;
  useEffect(() => {
    editorRef.current = plain;
  }, [plain]);
  useRelockCopies({ client, noteId, editor: plain, locked, enabled: !readOnly, allowance: me });
  const loadImage = useCallback(
    async (url: string) => {
      const id = idFromRef(url);
      if (id) return loadAttachmentBlob(client, id);
      return (await fetch(url)).blob();
    },
    [client],
  );
  usePlainTextCopy(plain, loadImage);
  // Enter in the title: down into the note's first line (a new one above an
  // image the note starts with).
  useEffect(
    () =>
      onTitleEnter(noteId, () => {
        const view = editor.prosemirrorView;
        if (!view?.editable) return false;
        view.dispatch(fromTitle(view.state));
        view.focus();
        return true;
      }),
    [editor, noteId],
  );

  return (
    <ImageCrop editor={plain} noteId={noteId} editable={!readOnly}>
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        className="memoca-editor min-h-[50vh] py-4"
        data-locked={locked ? "true" : undefined}
        formattingToolbar={false}
        slashMenu={false}
      >
        {/* BlockNote's / menu, with 二列 and 三列 among its basic blocks. Not
            in a table's cells, as BlockNote's own is not. */}
        <SuggestionMenuController
          triggerCharacter="/"
          shouldOpen={(state) => !state.selection.$from.parent.type.isInGroup("tableContent")}
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...combineByGroup(
                  getDefaultReactSlashMenuItems(editor),
                  getMultiColumnSlashMenuItems(editor),
                ),
                ...(await templateItems()),
              ],
              query,
            )
          }
        />
        {/* BlockNote's own toolbar, with トリミング added for images. */}
        {/* The floating one only, on a phone too: BlockNote's own for a phone
            (from 0.55) is pinned above the keyboard, where Memoca's block bar
            (MobileBlockToolbar) is, and covered it. */}
        <DesktopFormattingToolbarController
          formattingToolbar={MemocaFormattingToolbar}
          floatingUIOptions={mediaSelected ? OVER_MEDIA : undefined}
        />
        <ToolbarOnImageTap />
        <MobileBlockToolbar />
      </BlockNoteView>
    </ImageCrop>
  );
}
