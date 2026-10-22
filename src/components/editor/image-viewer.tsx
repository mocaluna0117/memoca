"use client";

import { useBlockNoteEditor } from "@blocknote/react";
import { Download, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { downloadBlockFile } from "@/components/editor/file-download-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { vault } from "@/lib/crypto/vault";
import { t } from "@/lib/i18n/ja";
import { idFromRef } from "@/lib/media/ref";
import { cn } from "@/lib/utils";

/**
 * The image block whose picture an event landed on, by its id: the picture
 * itself, in this editor. Not its caption, its resize handles, the preview
 * of one still being added, nor any text, where a double-click keeps doing
 * what it did (a word chosen, say).
 */
export function imageBlockAt(
  target: EventTarget | null,
  root: Element | null | undefined,
): string | null {
  if (!root || !(target instanceof HTMLImageElement)) return null;
  if (!target.classList.contains("bn-visual-media")) return null;
  const content = target.closest('[data-content-type="image"]');
  if (!content || !root.contains(content)) return null;
  return content.closest("[data-id]")?.getAttribute("data-id") ?? null;
}

/** A tap on an image: the block it is in, when (ms), and where. */
export type Tap = { blockId: string; at: number; x: number; y: number };

/** How soon after the first the second tap of a double tap comes, at most. */
export const DOUBLE_TAP_MS = 350;
/** How far from the first it lands, at most. */
export const DOUBLE_TAP_PX = 40;

/** Whether a tap is the second of a double tap: on the same image, soon after the first, near it. */
export function isDoubleTap(previous: Tap | null, tap: Tap): boolean {
  return (
    previous !== null &&
    previous.blockId === tap.blockId &&
    tap.at >= previous.at &&
    tap.at - previous.at <= DOUBLE_TAP_MS &&
    Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_PX
  );
}

/** A press made with a finger or a pen, which the browser gives no double-click for everywhere. */
const tapping = (pointerType: string) => pointerType === "touch" || pointerType === "pen";

type Viewing = { url: string; name: string };

/**
 * Opens an image of the note over the whole window when it is double-clicked,
 * or tapped twice on a touch screen.
 *
 * Only the picture itself opens it: a double-click on text still chooses a
 * word, and the caption, the resize handles and a drag of the image are
 * BlockNote's as before. A single click still chooses the image, as the
 * first click of the two does. The note may be read-only (waiting to be
 * encrypted) or locked: the image is shown as the note shows it.
 *
 * A finger's two taps are told from the clicks the browser makes of them,
 * which come only for a tap: never for a press that scrolled, nor for one
 * held to choose text. A double-click made of two taps comes in some
 * browsers and not in others, and is let go. The image is kept from the
 * page's zoom at a double tap (touch-action, in globals.css); a pinch
 * still zooms.
 */
export function ImageViewerOnDoubleClick({ locked }: { locked: boolean }) {
  const editor = useBlockNoteEditor();
  const [viewing, setViewing] = useState<Viewing | null>(null);

  useEffect(() => {
    let pointer = "mouse";
    let lastTap: Tap | null = null;
    const open = (blockId: string) => {
      const block = editor.getBlock(blockId);
      const props =
        block?.type === "image" ? (block.props as { url?: unknown; name?: unknown }) : null;
      if (!props || typeof props.url !== "string" || !props.url) return;
      setViewing({ url: props.url, name: typeof props.name === "string" ? props.name : "" });
    };
    const onPointerDown = (event: PointerEvent) => {
      pointer = event.pointerType;
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (tapping(pointer) || event.button !== 0) return;
      const blockId = imageBlockAt(event.target, editor.domElement);
      if (blockId) open(blockId);
    };
    const onClick = (event: MouseEvent) => {
      if (!tapping(pointer)) return;
      const blockId = imageBlockAt(event.target, editor.domElement);
      if (!blockId) {
        lastTap = null;
        return;
      }
      const tap = { blockId, at: event.timeStamp, x: event.clientX, y: event.clientY };
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null;
        open(blockId);
      } else {
        lastTap = tap;
      }
    };
    const options = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", onPointerDown, options);
    document.addEventListener("dblclick", onDoubleClick);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, options);
      document.removeEventListener("dblclick", onDoubleClick);
      document.removeEventListener("click", onClick);
    };
  }, [editor]);

  // The same lookup that gave the note its <img>: a locked note's image
  // decrypted here, once, as a URL of this tab's; any other from the device
  // when it is there, else from the server.
  const resolve = useCallback(
    async (url: string) => (editor.resolveFileUrl ? editor.resolveFileUrl(url) : url),
    [editor],
  );
  const close = useCallback(() => setViewing(null), []);
  // Back to the image on a computer, so the keyboard carries on from there.
  // On a phone that would raise the keyboard over the note.
  const returnFocus = useCallback((): boolean => {
    if (!window.matchMedia("(pointer: fine)").matches) return true;
    if (!editor.isEditable || !editor.domElement?.isConnected) return false;
    editor.focus();
    return true;
  }, [editor]);

  if (!viewing) return null;
  return (
    <ImageViewer
      key={viewing.url}
      url={viewing.url}
      name={viewing.name}
      locked={locked}
      resolve={resolve}
      onClose={close}
      onDownload={() => void downloadBlockFile(editor, viewing.url, viewing.name)}
      returnFocus={returnFocus}
    />
  );
}

type Source = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "unavailable" };
type Size = { width: number; height: number };
/** Where a click on the image was, to stay under the pointer as it is shown at its own size. */
type Anchor = { fx: number; fy: number; x: number; y: number };

/**
 * An image over the whole window, on a dark backdrop: made to fit, or at its
 * own size (100%) at a click on it, to scroll around. Esc, × or a click
 * beside the image closes it. ダウンロード saves the file the note holds,
 * as the toolbar's button does.
 *
 * A locked note's image, or any shown from a URL of this tab's, goes when
 * the vault closes: the URL is let go of then (revokeResolvedUrls).
 */
export function ImageViewer({
  url,
  name,
  locked,
  resolve,
  onClose,
  onDownload,
  returnFocus,
}: {
  /** The block's own (memoca://, or a web page's address). */
  url: string;
  name: string;
  /** The note is locked. */
  locked: boolean;
  /** What the block's URL is shown from (see BlockNote's resolveFileUrl). */
  resolve: (url: string) => Promise<string>;
  onClose: () => void;
  onDownload: () => void;
  /** Puts the focus back where it belongs, once closed: false to leave it to the dialog. */
  returnFocus: () => boolean;
}) {
  const [source, setSource] = useState<Source>({ kind: "loading" });
  const [natural, setNatural] = useState<Size | null>(null);
  const [room, setRoom] = useState<Size | null>(null);
  const [actual, setActual] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const anchor = useRef<Anchor | null>(null);
  // What is shown, for the vault's closing to read.
  const shown = useRef<Source>(source);
  const show = useCallback((next: Source) => {
    shown.current = next;
    setSource(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolve(url).then(
      (resolved) => {
        // One that could not be looked up comes back as it was.
        if (!cancelled) {
          show(
            resolved && !idFromRef(resolved)
              ? { kind: "ready", url: resolved }
              : { kind: "unavailable" },
          );
        }
      },
      // The vault closed on the way, say.
      () => {
        if (!cancelled) show({ kind: "unavailable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, resolve, show]);

  useEffect(
    () =>
      vault.subscribe((unlocked) => {
        if (unlocked) return;
        const current = shown.current;
        if (locked || current.kind !== "ready" || current.url.startsWith("blob:")) onClose();
      }),
    [locked, onClose],
  );

  // The room the image has, measured as it loads and as the window changes.
  const measure = useCallback(() => {
    const element = stage.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const across = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const down = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    setRoom({
      width: element.clientWidth - (across || 0),
      height: element.clientHeight - (down || 0),
    });
  }, []);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Larger than the room it has: it can be shown at its own size.
  const zoomable =
    !!natural && !!room && (natural.width > room.width || natural.height > room.height);

  const zoom = (next: boolean, at: Anchor | null) => {
    anchor.current = next ? at : null;
    setActual(next);
  };

  // At its own size, the point clicked stays under the pointer (or the
  // middle in the middle), rather than the image starting at its corner.
  useLayoutEffect(() => {
    const at = anchor.current;
    anchor.current = null;
    const element = stage.current;
    const picture = image.current;
    if (!actual || !at || !element || !picture) return;
    const box = picture.getBoundingClientRect();
    element.scrollLeft += box.left + at.fx * box.width - at.x;
    element.scrollTop += box.top + at.fy * box.height - at.y;
  }, [actual]);

  const middle = (): Anchor | null => {
    const element = stage.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { fx: 0.5, fy: 0.5, x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };

  const title = name || t.imageViewer.untitled;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-no-drawer-swipe
        data-memoca-image-viewer
        showCloseButton={false}
        // Dark whatever the theme: a photo is seen best on black.
        className="dark top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-black/90 p-0 text-foreground ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeButton.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus()) event.preventDefault();
        }}
      >
        <div
          className="flex items-center gap-1 px-2 py-2"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <div className="min-w-0 flex-1 px-2">
            <DialogTitle className="truncate text-sm font-medium">{title}</DialogTitle>
            <DialogDescription className="sr-only">{t.imageViewer.hint}</DialogDescription>
          </div>
          {zoomable ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={actual ? t.imageViewer.fit : t.imageViewer.actualSize}
              onClick={() => zoom(!actual, middle())}
            >
              {actual ? <ZoomOut aria-hidden /> : <ZoomIn aria-hidden />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.imageViewer.download}
            disabled={source.kind !== "ready"}
            onClick={onDownload}
          >
            <Download aria-hidden />
          </Button>
          <Button
            ref={closeButton}
            variant="ghost"
            size="icon-sm"
            aria-label={t.imageViewer.close}
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        </div>
        <div className="relative min-h-0 flex-1">
          {/* The backdrop: a click on it, beside the image, closes. */}
          <div
            ref={stage}
            data-image-viewer-stage
            className="absolute inset-0 flex overflow-auto overscroll-contain p-2 sm:p-6"
            style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            {source.kind === "ready" ? (
              // A URL the note already shows; next/image has nothing to optimise here.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={image}
                src={source.url}
                alt={title}
                draggable={false}
                className={cn(
                  "m-auto block shrink-0 select-none",
                  actual ? "max-w-none" : "max-h-full max-w-full",
                  zoomable && (actual ? "cursor-zoom-out" : "cursor-zoom-in"),
                )}
                style={
                  actual && natural ? { width: natural.width, height: natural.height } : undefined
                }
                onLoad={(event) => {
                  const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                  setNatural({ width, height });
                  measure();
                }}
                onError={() => show({ kind: "unavailable" })}
                onClick={(event) => {
                  if (!zoomable) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  zoom(!actual, {
                    fx: box.width ? (event.clientX - box.left) / box.width : 0.5,
                    fy: box.height ? (event.clientY - box.top) / box.height : 0.5,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              />
            ) : source.kind === "loading" ? (
              <p
                role="status"
                className="m-auto flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t.imageViewer.loading}
              </p>
            ) : (
              <p role="alert" className="m-auto max-w-sm text-center text-sm text-muted-foreground">
                {t.imageViewer.unavailable}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
