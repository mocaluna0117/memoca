"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import { ja as blocknoteJa } from "@blocknote/core/locales";
import type { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { FormattingToolbarController, useCreateBlockNote } from "@blocknote/react";
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
  prepareUpload,
  resolveAttachment,
  stageUpload,
} from "@/lib/media/attachments";
import { uploadRefusal } from "@/lib/media/refusal";
import { warmWebpEncoder } from "@/lib/media/webp-encoder";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";

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
        dictionary: blocknoteJa,
        uploadFile,
        resolveFileUrl,
      }),
    [doc, me?.name, uploadFile, resolveFileUrl],
  );

  const editor = useCreateBlockNote(options, [doc]);
  useEffect(() => {
    editorRef.current = editor as unknown as BlockNoteEditor;
  }, [editor]);
  useRelockCopies({ client, noteId, editor, enabled: locked && !readOnly, allowance: me });

  return (
    <ImageCrop editor={editor} noteId={noteId} editable={!readOnly}>
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        className="memoca-editor min-h-[50vh] py-4"
        data-locked={locked ? "true" : undefined}
        formattingToolbar={false}
      >
        {/* BlockNote's own toolbar, with トリミング added for images. */}
        <FormattingToolbarController formattingToolbar={MemocaFormattingToolbar} />
        <ToolbarOnImageTap />
        <MobileBlockToolbar />
      </BlockNoteView>
    </ImageCrop>
  );
}
