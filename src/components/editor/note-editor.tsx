"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import { ja as blocknoteJa } from "@blocknote/core/locales";
import { withCollaboration } from "@blocknote/core/yjs";
import { FormattingToolbarController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useConvex } from "convex/react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type * as Y from "yjs";
import { useSync } from "@/components/providers/sync-provider";
import {
  ImageCrop,
  MemocaFormattingToolbar,
  ToolbarOnImageTap,
} from "@/components/editor/image-crop";
import { MobileBlockToolbar } from "@/components/editor/mobile-block-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { vault } from "@/lib/crypto/vault";
import {
  QuotaError,
  idFromRef,
  resolveAttachment,
  stageUpload,
} from "@/lib/media/attachments";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";
import { t } from "@/lib/i18n/ja";

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

  const uploadFile = useCallback(
    async (file: File) => {
      try {
        return await stageUpload({ noteId, file, locked });
      } catch (error) {
        toast.error(error instanceof QuotaError ? t.quota.exceeded : "追加できませんでした");
        throw error;
      }
    },
    [noteId, locked],
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
