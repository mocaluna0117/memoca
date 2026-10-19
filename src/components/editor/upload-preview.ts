import type { BlockNoteEditor } from "@blocknote/core";
import { shownType } from "@/lib/media/shown-type";

/**
 * How long the preview's URL is kept once the upload is over. The block is
 * drawn again with the staged file (or put right, for a file refused) as
 * soon as it is, but an image still being decoded from a URL let go would
 * go blank first.
 */
const REVOKE_AFTER_MS = 2_000;

/** What BlockNote shows in a file block from an upload's start until the block has its URL. */
const LOADING = ".bn-file-loading-preview";

/**
 * Shows an image being added to a note at once, in the block BlockNote made
 * for it, while it is made smaller and staged: the block said "Loading..."
 * for as long as that took, a second idle and several in a meeting. The
 * original is shown dimmed, from a URL of the file itself, in the box the
 * words were in, and the block itself is left as it is: a URL written to it
 * now would reach the document, the outbox and the undo history. BlockNote
 * draws the block again, with the staged file, once the upload is over, and
 * an image block's node view takes no notice of what is put inside it
 * meanwhile. Nothing is shown for a file that would not be shown as an
 * image (an SVG), or where no block is loading for it. Returns what lets
 * the URL go, once the upload is over.
 */
export function showUploadPreview(
  editor: BlockNoteEditor | null,
  blockId: string | undefined,
  file: File,
): () => void {
  const nothing = () => {};
  if (!blockId || !file.type.startsWith("image/") || shownType(file.type) !== file.type) {
    return nothing;
  }
  const loading = editor?.domElement?.querySelector<HTMLElement>(
    `[data-id="${CSS.escape(blockId)}"] ${LOADING}`,
  );
  if (!loading) return nothing;
  const url = URL.createObjectURL(file);
  const image = document.createElement("img");
  image.className = "memoca-upload-preview";
  image.src = url;
  image.alt = "";
  image.draggable = false;
  image.setAttribute("contenteditable", "false");
  // One this browser cannot show after all (a HEIC photo in Chrome): the words back.
  image.onerror = () => {
    loading.textContent = "Loading...";
  };
  const label = document.createElement("span");
  label.className = "memoca-upload-preview-label";
  label.textContent = "処理中…";
  loading.replaceChildren(image, label);
  return () => {
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  };
}
