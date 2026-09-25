"use client";

import "react-image-crop/dist/ReactCrop.css";

import { useConvex } from "convex/react";
import { Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import ReactCrop from "react-image-crop";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CropTarget } from "@/components/editor/image-crop";
import { vault } from "@/lib/crypto/vault";
import { useMediaQuery } from "@/lib/hooks/use-client-value";
import { AttachmentUnavailableError, idFromRef, loadAttachmentBlob } from "@/lib/media/attachments";
import { type CroppedImage, MAX_IMAGE_EDGE, cropImage } from "@/lib/media/compress";
import {
  PERCENT,
  type Rect,
  type Size,
  WHOLE,
  aspectCrop,
  keepsWholeImage,
  planCrop,
} from "@/lib/media/crop";
import { cn } from "@/lib/utils";
import styles from "./image-crop-dialog.module.css";

const PRESETS: { label: string; aspect: number | undefined }[] = [
  { label: "自由", aspect: undefined },
  { label: "1:1", aspect: 1 },
  { label: "4:3", aspect: 4 / 3 },
  { label: "16:9", aspect: 16 / 9 },
];

const ARIA_LABELS = {
  cropArea: "残す範囲。矢印キーで動かせます",
  nwDragHandle: "左上の角。矢印キーで範囲を変えられます",
  nDragHandle: "上の辺。矢印キーで範囲を変えられます",
  neDragHandle: "右上の角。矢印キーで範囲を変えられます",
  eDragHandle: "右の辺。矢印キーで範囲を変えられます",
  seDragHandle: "右下の角。矢印キーで範囲を変えられます",
  sDragHandle: "下の辺。矢印キーで範囲を変えられます",
  swDragHandle: "左下の角。矢印キーで範囲を変えられます",
  wDragHandle: "左の辺。矢印キーで範囲を変えられます",
};

/**
 * Too small for a box in the middle of the screen: a phone upright, or on its
 * side, where 90% of the height leaves too little room for the image between
 * the header and the buttons.
 */
const CRAMPED = "(width < 40rem), (height < 32rem)";

/**
 * The height, in pixels, inside the padding of the element given to the
 * returned ref, kept up to date as the window changes.
 *
 * The crop box sizes the image by `max-height`, which a percentage cannot
 * give it (its wrapper inherits the value), so the room is measured. A ref
 * callback, because the dialog's content mounts a render after the dialog.
 */
function useInnerHeight(): [(element: HTMLElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(Math.floor(entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, height];
}

/**
 * Chooses the part of an image to keep.
 *
 * Loaded only when someone asks to trim, so the crop box and its styles are
 * not part of the editor's own download. The image is read from its bytes
 * (see {@link loadAttachmentBlob}) and shown from a URL this dialog owns and
 * revokes, which also covers a locked note's decrypted image.
 */
export function ImageCropDialog({
  target,
  onCancel,
  onCrop,
  returnFocus,
}: {
  target: CropTarget;
  onCancel: () => void;
  /** Resolves true once the crop has been used, false to stay open and let the person adjust it. */
  onCrop: (image: CroppedImage) => Promise<boolean>;
  /** The button that opened this is gone by the time it closes. */
  returnFocus: () => void;
}) {
  const client = useConvex();
  const [source, setSource] = useState<{ blob: Blob; url: string } | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [crop, setCrop] = useState<Rect>(WHOLE);
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const calm = useMediaQuery("(prefers-reduced-motion: reduce)");
  const cramped = useMediaQuery(CRAMPED);
  const [area, room] = useInnerHeight();

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const attachmentId = idFromRef(target.originalUrl);
    if (!attachmentId) return;
    loadAttachmentBlob(client, attachmentId).then(
      (blob) => {
        if (cancelled) return;
        if (blob.type === "image/gif") {
          // Drawing a GIF to a canvas keeps only its first frame.
          toast.error("GIF は動きが失われるため、トリミングできません。");
          onCancel();
          return;
        }
        url = URL.createObjectURL(blob);
        setSource({ blob, url });
      },
      (error: unknown) => {
        if (cancelled) return;
        toast.error(
          error instanceof AttachmentUnavailableError && error.reason === "offline"
            ? "オフラインのため、この画像はいまトリミングできません。"
            : "画像を読み込めませんでした。もう一度お試しください。",
        );
        onCancel();
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, target.originalUrl, onCancel]);

  const unchanged = natural
    ? keepsWholeImage(planCrop(crop, PERCENT, natural, MAX_IMAGE_EDGE), natural)
    : true;

  const choose = (next: number | undefined) => {
    setAspect(next);
    if (next !== undefined && natural) setCrop(aspectCrop(next, natural));
  };

  const reset = () => {
    setAspect(undefined);
    setCrop(WHOLE);
  };

  const confirm = async () => {
    if (!source) return;
    setBusy(true);
    // A locked note's edit is encrypted as it is saved, so the vault waits
    // for the crop to land before it closes, rather than cutting it off.
    const release = vault.hold();
    try {
      const done = await onCrop(await cropImage(source.blob, crop));
      if (!done) setBusy(false);
    } catch {
      toast.error("トリミングできませんでした。もう一度お試しください。");
      setBusy(false);
    } finally {
      release();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        data-no-drawer-swipe
        showCloseButton={false}
        // A fixed height, so the image is sized to the room left for it and
        // not the other way round.
        className={cn(
          "flex flex-col",
          cramped
            ? "top-0 left-0 h-dvh max-w-none translate-x-0 translate-y-0 rounded-none pt-[max(1rem,env(safe-area-inset-top))] sm:max-w-none"
            : "h-[min(90dvh,44rem)] sm:max-w-2xl",
        )}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>画像をトリミング</DialogTitle>
          {/* A short screen needs the line for the image. */}
          <DialogDescription className="[@media(height<32rem)]:sr-only">
            角をドラッグして、残す範囲を選びます。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1">
          <div role="group" aria-label="縦横比" className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant={aspect === preset.aspect ? "secondary" : "ghost"}
                aria-pressed={aspect === preset.aspect}
                disabled={!natural || busy}
                onClick={() => choose(preset.aspect)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={!natural || busy}
            onClick={reset}
          >
            <RotateCcw aria-hidden />
            リセット
          </Button>
        </div>

        {/* Room around the image for the handles, which sit across its edges. */}
        <div
          ref={area}
          className="bg-muted/50 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg p-4 pointer-coarse:p-6"
        >
          {source ? (
            <ReactCrop
              crop={{ unit: "%", ...crop }}
              aspect={aspect}
              keepSelection
              ruleOfThirds
              minWidth={16}
              minHeight={16}
              disabled={busy}
              ariaLabels={ARIA_LABELS}
              onChange={(_, percent) => setCrop(percent)}
              style={room ? { maxHeight: room } : undefined}
              className={cn(
                styles.crop,
                // A still outline instead of the marching one.
                calm && "ReactCrop--no-animate",
              )}
            >
              {/* A blob: URL this dialog made; next/image has nothing to optimise here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={source.url}
                alt={target.name || "画像"}
                draggable={false}
                onLoad={(event) =>
                  setNatural({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
            </ReactCrop>
          ) : (
            <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              画像を読み込んでいます
            </p>
          )}
        </div>

        <DialogFooter
          className={cn(
            "max-sm:flex-row max-sm:*:flex-1",
            cramped && "rounded-none pb-[max(1rem,env(safe-area-inset-bottom))]",
          )}
        >
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            キャンセル
          </Button>
          <Button
            type="button"
            disabled={!source || !natural || unchanged || busy}
            aria-busy={busy}
            onClick={() => void confirm()}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            トリミングする
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
