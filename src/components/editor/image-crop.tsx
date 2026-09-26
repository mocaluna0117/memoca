"use client";

import type { BlockNoteEditor } from "@blocknote/core";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import {
  FormattingToolbar,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
  useExtension,
} from "@blocknote/react";
import { useLiveQuery } from "dexie-react-hooks";
import { Crop } from "lucide-react";
import dynamic from "next/dynamic";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useSync } from "@/components/providers/sync-provider";
import { vault } from "@/lib/crypto/vault";
import { db } from "@/lib/db";
import {
  type AppliedCrop,
  type CropTarget,
  applyCrop,
  copiesLockedFile,
  revertCrop,
} from "@/lib/media/apply-crop";
import { idFromRef, isLockedFile } from "@/lib/media/attachments";
import type { CroppedImage } from "@/lib/media/compress";
import { tooLargeMessage } from "@/lib/media/refusal";
import { t } from "@/lib/i18n/ja";

export type { CropTarget } from "@/lib/media/apply-crop";

// The crop box is only needed once someone asks for it.
const ImageCropDialog = dynamic(
  () => import("@/components/editor/image-crop-dialog").then((m) => m.ImageCropDialog),
  { ssr: false },
);

type AnyBlock = { id: string; type: string; props: Record<string, unknown> };

const ImageCropContext = createContext<((target: CropTarget) => void) | null>(null);

const LOCKED_SOURCE =
  "この画像はロックしたメモのものなので、ロックしていないメモではトリミングできません。";
const READ_ONLY = "このメモはいま編集できないため、トリミングしませんでした。";

/**
 * The image block among these, if it is one that can be trimmed: a single
 * image stored by this app (an embedded link would taint the canvas), and not
 * a GIF, whose animation a crop would flatten to one frame.
 *
 * Offered while the file's type is still being looked up. Adding the button
 * a moment later made BlockNote's toolbar grow after it had been placed, past
 * the edge of a phone's screen; the dialog turns a GIF away in any case.
 */
export function useCropTarget(block: AnyBlock | undefined, editable: boolean): CropTarget | null {
  const url = typeof block?.props.url === "string" ? block.props.url : "";
  const name = typeof block?.props.name === "string" ? block.props.name : "";
  const attachmentId = editable && block?.type === "image" ? idFromRef(url) : null;
  const gif = useLiveQuery(
    async () =>
      attachmentId ? (await db().attachments.get(attachmentId))?.mime === "image/gif" : false,
    [attachmentId],
  );
  if (!block || !attachmentId || gif === true || /\.gif$/i.test(name)) return null;
  return { blockId: block.id, originalUrl: url, name };
}

/** Opens the crop dialog for an image, from either toolbar. */
export function useOpenCrop() {
  return useContext(ImageCropContext);
}

/**
 * Holds the crop dialog for one editor, and applies what it produces (see
 * {@link applyCrop}).
 *
 * The result is a new attachment, and the block is pointed at it; the
 * original stays stored, so undo, and the 元に戻す in the toast, can point the
 * block back. A locked note's crop goes up encrypted like any of its files.
 */
export function ImageCrop({
  editor,
  noteId,
  editable,
  children,
}: {
  editor: BlockNoteEditor;
  noteId: string;
  /** False while the note may not be changed, such as while it waits to be encrypted. */
  editable: boolean;
  children: ReactNode;
}) {
  const { me } = useSync();
  // `locked`: the image is kept encrypted, so the dialog shows it decrypted.
  const [target, setTarget] = useState<(CropTarget & { locked: boolean }) | null>(null);
  const close = useCallback(() => setTarget(null), []);
  // Back to the image on a computer, so the keyboard carries on from there. On
  // a phone that would raise the keyboard over the result.
  const returnFocus = useCallback(() => {
    if (window.matchMedia("(pointer: fine)").matches && editor.domElement?.isConnected) {
      editor.focus();
    }
  }, [editor]);

  // An undo offered for this editor cannot outlive it, and neither can a
  // crop still being saved when the note is closed.
  const offers = useRef(new Set<string | number>());
  const mounted = useRef(false);
  useEffect(() => {
    const shown = offers.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const id of shown) toast.dismiss(id);
    };
  }, []);

  // A note that turns read-only, say because it now waits to be encrypted,
  // takes the dialog and any undo still on offer with it: nothing may change
  // it until the lock goes on.
  const [wasEditable, setWasEditable] = useState(editable);
  if (editable !== wasEditable) {
    setWasEditable(editable);
    if (!editable) setTarget(null);
  }
  useEffect(() => {
    if (editable) return;
    for (const id of offers.current) toast.dismiss(id);
    offers.current.clear();
  }, [editable]);

  // A locked image goes when the vault closes, as the note's own copy does.
  useEffect(
    () =>
      vault.subscribe((unlocked) => {
        if (!unlocked) setTarget((current) => (current?.locked ? null : current));
      }),
    [],
  );

  const open = useCallback(
    (next: CropTarget) => {
      void (async () => {
        if (await copiesLockedFile(noteId, next.originalUrl)) {
          toast.error(LOCKED_SOURCE);
          return;
        }
        const locked = await isLockedFile(idFromRef(next.originalUrl)!);
        if (mounted.current) setTarget({ ...next, locked });
      })();
    },
    [noteId],
  );

  const offerUndo = (cropped: CropTarget, applied: AppliedCrop) => {
    const id = toast("画像をトリミングしました", {
      duration: 10_000,
      action: {
        label: "元に戻す",
        onClick: () => {
          offers.current.delete(id);
          const result = revertCrop(editor, cropped, applied);
          if (result === "readOnly") {
            toast.error("このメモはいま編集できないため、元に戻せませんでした。");
          } else if (result === "changed") {
            toast.error("画像がその後に変更されたため、元に戻せませんでした。");
          }
        },
      },
      onDismiss: () => offers.current.delete(id),
      onAutoClose: () => offers.current.delete(id),
    });
    offers.current.add(id);
  };

  const apply = async (image: CroppedImage): Promise<boolean> => {
    if (!target) return true;
    const outcome = await applyCrop({
      editor,
      noteId,
      target,
      image,
      me,
      alive: () => mounted.current,
    });
    switch (outcome.status) {
      case "tooLarge":
        // The dialog stays open: a smaller part may still fit.
        toast.error(outcome.limit === undefined ? t.quota.exceeded : tooLargeMessage("image", outcome.limit));
        return false;
      case "gone":
        return true;
      case "changed":
        toast.error("画像がほかで変更されたため、トリミングしませんでした。");
        break;
      case "readOnly":
        toast.error(READ_ONLY);
        break;
      case "lockedSource":
        toast.error(LOCKED_SOURCE);
        break;
      case "applied":
        offerUndo(target, outcome);
        break;
    }
    setTarget(null);
    return true;
  };

  return (
    <ImageCropContext.Provider value={open}>
      {children}
      {target ? (
        <ImageCropDialog
          key={`${target.blockId}:${target.originalUrl}`}
          target={target}
          onCancel={close}
          onCrop={apply}
          returnFocus={returnFocus}
        />
      ) : null}
    </ImageCropContext.Provider>
  );
}

/** The crop button in BlockNote's own toolbar, shown for an image that can be trimmed. */
function ImageCropButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const open = useOpenCrop();
  const block = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable) return undefined;
      const blocks = editor.getSelection()?.blocks || [editor.getTextCursorPosition().block];
      return blocks.length === 1 ? blocks[0] : undefined;
    },
  });
  const target = useCropTarget(block, true);
  if (!target || !open) return null;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="トリミング"
      mainTooltip="トリミング"
      icon={<Crop />}
      onClick={() => open(target)}
    />
  );
}

/**
 * Brings BlockNote's toolbar back when an image that is already selected is
 * tapped.
 *
 * BlockNote shows it again on pointerup, but only if the editor has focus by
 * then, and a finger focuses the editor later than that. A tap that selects
 * the image shows it anyway, through the selection change; a tap on the image
 * that is still selected, say after the crop dialog closed, changes nothing,
 * and the toolbar, with トリミング on it, would not come back.
 */
export function ToolbarOnImageTap() {
  const editor = useBlockNoteEditor();
  const toolbar = useExtension(FormattingToolbarExtension, { editor });
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const root = editor.domElement;
      if (!(event.target instanceof Element) || !root?.contains(event.target)) return;
      const image = event.target.closest('[data-content-type="image"]');
      const blockId = image?.closest("[data-id]")?.getAttribute("data-id");
      if (!blockId || !editor.isEditable || !editor.isFocused() || toolbar.store.state) return;
      if (editor.prosemirrorState.selection.empty) return;
      if (editor.getTextCursorPosition().block.id === blockId) toolbar.store.setState(true);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [editor, toolbar]);
  return null;
}

/** BlockNote's formatting toolbar, with トリミング next to the replace button. */
export function MemocaFormattingToolbar() {
  const items = getFormattingToolbarItems();
  const at = items.findIndex((item) => item.key === "replaceFileButton");
  items.splice(at + 1, 0, <ImageCropButton key="imageCropButton" />);
  return <FormattingToolbar>{items}</FormattingToolbar>;
}
