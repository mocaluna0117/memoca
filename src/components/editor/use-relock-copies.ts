"use client";

import type { BlockNoteEditor } from "@blocknote/core";
import type { ConvexReactClient } from "convex/react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { Allowance } from "@/lib/media/attachments";
import { relockCopies } from "@/lib/media/relock-copies";

/** Edits are let settle this long before the note is looked at again. */
const SETTLE_MS = 1_000;

/**
 * While a locked note is open, gives it its own encrypted copy of any file
 * pasted in from another note, as soon as it arrives: that file belongs to
 * the other note and would otherwise stay readable on the server. Runs when
 * the note opens and after each burst of edits. The copy replaces the pasted
 * file in the document directly, so it appears in place and is not an undo
 * step.
 */
export function useRelockCopies({
  client,
  noteId,
  editor,
  enabled,
  allowance,
}: {
  client: ConvexReactClient;
  noteId: string;
  editor: BlockNoteEditor;
  /** The note is locked and can be edited. */
  enabled: boolean;
  allowance: Allowance | null | undefined;
}): void {
  const figures = useRef(allowance);
  useEffect(() => {
    figures.current = allowance;
  }, [allowance]);
  // Said once per note: every edit would otherwise say it again.
  const warned = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      void relockCopies(client, noteId, { allowance: figures.current })
        .then((outcome) => {
          if (!alive || outcome.tooLarge === 0 || warned.current) return;
          warned.current = true;
          toast.error(
            "ほかのメモからコピーした画像を、このメモ用に暗号化する容量が足りません。不要なファイルを削除してください。",
          );
        })
        .catch(() => {});
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, SETTLE_MS);
    };
    run();
    const unsubscribe = editor.onChange(schedule);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [client, noteId, editor, enabled]);
}
