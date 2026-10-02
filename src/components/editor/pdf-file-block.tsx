"use client";

import { createFileBlockConfig, fileParse } from "@blocknote/core";
import {
  FileBlockWrapper,
  FileNameWithIcon,
  LinkWithCaption,
  type ReactCustomBlockRenderProps,
  createReactBlockSpec,
} from "@blocknote/react";
import { useConvex } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download, FileText, Maximize2, Minus, Plus, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { downloadBlockFile } from "@/components/editor/file-download-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { db } from "@/lib/db";
import { t } from "@/lib/i18n/ja";
import { idFromRef, loadAttachmentBlob } from "@/lib/media/attachments";
import { aspectOf, closePdf, drawPage, openPdf, wasCancelled } from "@/lib/media/pdf";

type FileProps = Omit<ReactCustomBlockRenderProps<typeof createFileBlockConfig>, "contentRef">;

/** A page's height for each unit of its width until it is known: A4's. */
const A4 = Math.SQRT2;
/** The widest the note shows a PDF's first page. */
const CARD_WIDTH = 320;
/** The widest the viewer shows its pages, at 100%. */
const VIEWER_WIDTH = 900;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

/**
 * BlockNote's file block, with a PDF shown as its first page: a card with
 * its name and how many pages it has, which opens to every page. Any other
 * file, or one that turns out not to be a PDF, or cannot be read here, shows
 * as before, by its name. The block itself is BlockNote's, the same type
 * with the same props, so nothing about what is stored changes.
 */
export const memocaFileBlock = createReactBlockSpec(createFileBlockConfig, {
  meta: { fileBlockAccept: ["*/*"] },
  parse: fileParse(),
  render: (props) => <MemocaFile {...props} />,
  toExternalHTML: (props) => {
    if (!props.block.props.url) return <p>Add file</p>;
    const link = <a href={props.block.props.url}>{props.block.props.name || props.block.props.url}</a>;
    return props.block.props.caption ? (
      <LinkWithCaption caption={props.block.props.caption}>{link}</LinkWithCaption>
    ) : (
      link
    );
  },
});

const PDF_NAME = /\.pdf$/i;

function MemocaFile(props: FileProps) {
  const { url, name } = props.block.props;
  const attachmentId = idFromRef(url);
  // A PDF by its name, or by the type it was stored with (one named without
  // .pdf). Only this app's own files: another site's would need it to allow
  // being read.
  const mime = useLiveQuery(
    async () => (attachmentId ? ((await db().attachments.get(attachmentId))?.mime ?? null) : null),
    [attachmentId],
  );
  const pdf = attachmentId !== null && (PDF_NAME.test(name) || mime === "application/pdf");
  return (
    <FileBlockWrapper {...(props as unknown as Parameters<typeof FileBlockWrapper>[0])}>
      {pdf ? <PdfCard key={attachmentId} attachmentId={attachmentId} file={props} /> : undefined}
    </FileBlockWrapper>
  );
}

type Loaded =
  | { kind: "waiting" }
  | { kind: "ready"; doc: PDFDocumentProxy; aspect: number }
  /** Not a PDF after all, or not readable here: shown by its name. */
  | { kind: "none" };

/** A PDF's first page in the note, read once it comes near the screen. */
function PdfCard({ attachmentId, file }: { attachmentId: string; file: FileProps }) {
  const client = useConvex();
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "waiting" });
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState(false);
  const { name } = file.block.props;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px 0px" },
    );
    seen.observe(element);
    const sized = new ResizeObserver(() => setWidth(element.clientWidth));
    sized.observe(element);
    return () => {
      seen.disconnect();
      sized.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const doc = await openPdf(await loadAttachmentBlob(client, attachmentId));
        if (!doc) {
          if (!cancelled) setLoaded({ kind: "none" });
          return;
        }
        opened = doc;
        if (cancelled) {
          void closePdf(doc);
          return;
        }
        const aspect = aspectOf(await doc.getPage(1));
        if (!cancelled) setLoaded({ kind: "ready", doc, aspect });
      } catch {
        // Offline before it was ever on this device, the vault closed on
        // the way, or a file pdf.js cannot read.
        if (!cancelled) setLoaded({ kind: "none" });
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void closePdf(opened);
    };
  }, [near, client, attachmentId]);

  useEffect(() => {
    if (loaded.kind !== "ready" || !canvas.current || width === 0) return;
    let task: ReturnType<typeof drawPage> | null = null;
    let cancelled = false;
    void loaded.doc.getPage(1).then((page) => {
      if (cancelled || !canvas.current) return;
      task = drawPage(page, canvas.current, width);
      task.promise.catch((error: unknown) => {
        if (!wasCancelled(error)) setLoaded({ kind: "none" });
      });
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [loaded, width]);

  if (loaded.kind === "none") return <FileNameWithIcon {...(file as unknown as Parameters<typeof FileNameWithIcon>[0])} />;
  const pages = loaded.kind === "ready" ? loaded.doc.numPages : null;
  const aspect = loaded.kind === "ready" ? loaded.aspect : A4;

  return (
    <div
      ref={root}
      contentEditable={false}
      className="memoca-pdf border-border bg-card flex w-full flex-col overflow-hidden rounded-lg border"
      style={{ maxWidth: CARD_WIDTH }}
      data-pages={pages ?? undefined}
    >
      <div className="relative w-full overflow-hidden bg-white" style={{ aspectRatio: `1 / ${aspect}` }}>
        {loaded.kind === "ready" ? (
          <canvas ref={canvas} className="block" aria-hidden />
        ) : (
          <div className="bg-muted absolute inset-0 animate-pulse" />
        )}
      </div>
      <div className="border-border flex items-center gap-2 border-t px-3 py-2 text-sm">
        <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {pages !== null && (
          <span className="text-muted-foreground shrink-0 text-xs">{t.pdf.pages(pages)}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2"
          aria-label={t.pdf.openLabel(name)}
          disabled={loaded.kind !== "ready"}
          // Not to move the caret or select the block on the way.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setViewing(true)}
        >
          <Maximize2 className="size-3.5" aria-hidden />
          {t.pdf.open}
        </Button>
      </div>
      {loaded.kind === "ready" && (
        <PdfViewer
          open={viewing}
          onOpenChange={setViewing}
          doc={loaded.doc}
          aspect={loaded.aspect}
          name={name}
          onDownload={() => void downloadBlockFile(file.editor, file.block.props.url, name)}
        />
      )}
    </div>
  );
}

/** Every page of a PDF, over the whole window, to scroll through and zoom. */
function PdfViewer({
  open,
  onOpenChange,
  doc,
  aspect,
  name,
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: PDFDocumentProxy;
  aspect: number;
  name: string;
  onDownload: () => void;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(0);
  const [zoom, setZoom] = useState(2);

  useEffect(() => {
    if (!scroller) return;
    const sized = new ResizeObserver(() => setRoom(scroller.clientWidth));
    sized.observe(scroller);
    return () => sized.disconnect();
  }, [scroller]);

  const fit = Math.max(0, Math.min(room - 24, VIEWER_WIDTH));
  const width = Math.round(fit * ZOOMS[zoom]!);
  const pages = Array.from({ length: doc.numPages }, (_, index) => index + 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="memoca-pdf-viewer top-0 left-0 flex h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
      >
        <div
          className="border-border flex items-center gap-1 border-b px-2 py-2"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <div className="min-w-0 flex-1 px-2">
            <DialogTitle className="truncate text-sm font-medium">{name}</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              {t.pdf.pages(doc.numPages)}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.pdf.zoomOut}
            disabled={zoom === 0}
            onClick={() => setZoom((at) => Math.max(0, at - 1))}
          >
            <Minus aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-14 tabular-nums"
            aria-label={t.pdf.fit}
            onClick={() => setZoom(2)}
          >
            {Math.round(ZOOMS[zoom]! * 100)}%
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.pdf.zoomIn}
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => setZoom((at) => Math.min(ZOOMS.length - 1, at + 1))}
          >
            <Plus aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t.pdf.download} onClick={onDownload}>
            <Download aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t.pdf.close} onClick={() => onOpenChange(false)}>
            <X aria-hidden />
          </Button>
        </div>
        <div ref={setScroller} className="bg-muted min-h-0 flex-1 overflow-auto overscroll-contain">
          {width > 0 && (
            <div
              className="mx-auto flex flex-col gap-3 py-3"
              style={{ width, paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
            >
              {pages.map((index) => (
                <PdfPage key={index} doc={doc} index={index} width={width} aspect={aspect} root={scroller} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One page of the viewer, drawn while it is on the screen or near it, and
 * let go of once far from it: a long PDF drawn whole would hold more than a
 * phone has.
 */
function PdfPage({
  doc,
  index,
  width,
  aspect: guessed,
  root,
}: {
  doc: PDFDocumentProxy;
  index: number;
  width: number;
  aspect: number;
  root: HTMLElement | null;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [aspect, setAspect] = useState(guessed);

  useEffect(() => {
    const element = frame.current;
    if (!element || !root) return;
    const seen = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root, rootMargin: "150% 0px" },
    );
    seen.observe(element);
    return () => seen.disconnect();
  }, [root]);

  useEffect(() => {
    const target = canvas.current;
    if (!near || !target) return;
    let task: ReturnType<typeof drawPage> | null = null;
    let cancelled = false;
    void doc.getPage(index).then((page) => {
      if (cancelled) return;
      setAspect(aspectOf(page));
      task = drawPage(page, target, width);
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
      // Its pixels go with it.
      target.width = 0;
      target.height = 0;
    };
  }, [near, doc, index, width]);

  return (
    <div
      ref={frame}
      className="memoca-pdf-page overflow-hidden bg-white shadow-sm"
      style={{ width, height: Math.round(width * aspect) }}
      data-page={index}
    >
      <canvas ref={canvas} className="block" aria-hidden />
    </div>
  );
}
