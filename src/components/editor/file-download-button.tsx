"use client";

import { blockHasType } from "@blocknote/core";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useEditorState,
} from "@blocknote/react";
import { toast } from "sonner";
import { t } from "@/lib/i18n/ja";
import { downloadFile } from "@/lib/media/open-file";

/** BlockNote's own download icon (Remix Icon's download-2-fill), as the buttons beside it are drawn. */
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden>
      <path d="M4 19H20V12H22V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V12H4V19ZM14 9H19L12 16L5 9H10V3H14V9Z" />
    </svg>
  );
}

/**
 * BlockNote's download button for a file, an image or a video, with
 * {@link downloadFile}: saved under its name, or on an iPhone or an iPad
 * handed to the share sheet, rather than opened as it is. On an iPhone, a
 * file that took too long to fetch for the sheet is offered again, to hand
 * on at a press of its own.
 */
export function FileDownloadButton() {
  const Components = useComponentsContext()!;
  const dictionary = useDictionary();
  const editor = useBlockNoteEditor();
  const block = useEditorState({
    editor,
    selector: ({ editor }) => {
      const blocks = editor.getSelection()?.blocks || [editor.getTextCursorPosition().block];
      if (blocks.length !== 1) return undefined;
      const [only] = blocks;
      return only && blockHasType(only, editor, only.type, { url: "string" }) ? only : undefined;
    },
  });
  if (!block) return null;
  const label =
    dictionary.formatting_toolbar.file_download.tooltip[block.type] ??
    dictionary.formatting_toolbar.file_download.tooltip.file;
  const name = (block.props as { name?: string }).name ?? "";
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={label}
      mainTooltip={label}
      icon={<DownloadIcon />}
      onClick={async () => {
        editor.focus();
        const url = block.props.url as string;
        try {
          const opened = await downloadFile(
            editor.resolveFileUrl ? editor.resolveFileUrl(url) : url,
            name,
          );
          if (opened.kind === "unavailable") toast.error(t.download.unavailable);
          if (opened.kind === "ready") {
            toast(t.download.ready, {
              id: "download-ready",
              duration: 15_000,
              action: { label: t.download.share, onClick: () => void opened.share() },
            });
          }
        } catch {
          // Could not be looked up (the vault closed on the way, say).
          toast.error(t.download.unavailable);
        }
      }}
    />
  );
}
