"use client";

import { useConvex } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/bytes";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { useOnline } from "@/lib/hooks/use-online";
import { t } from "@/lib/i18n/ja";
import type { Allowance } from "@/lib/media/attachments";
import {
  type ConvertProgress,
  type ConvertReport,
  type Found,
  convertImages,
  findConvertible,
} from "@/lib/media/convert-images";

/**
 * Offers to write again as WebP the images stored as PNG or JPEG (from
 * before Safari could write WebP), with how many there are and their size,
 * and says how it went. Looked for when the page opens, the network comes
 * back, the vault opens (a locked note's file says its type only then) and
 * after a run; stopped if the page is left.
 */
export function ConvertImages({ allowance }: { allowance: Allowance }) {
  const client = useConvex();
  const { engine } = useSync();
  const online = useOnline();
  const unlocked = useVaultUnlocked();
  const [found, setFound] = useState<Found | "looking" | "failed">("looking");
  const [progress, setProgress] = useState<ConvertProgress | null>(null);
  const [report, setReport] = useState<ConvertReport | "failed" | null>(null);
  const [stopping, setStopping] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const title = useId();
  const running = progress !== null;
  // The account's figures as they are now, not as they were when the run
  // began: each copy it sends counts on the server as it goes.
  const latest = useRef(allowance);
  useEffect(() => {
    latest.current = allowance;
  }, [allowance]);

  useEffect(() => {
    if (running || !online) return;
    let current = true;
    void findConvertible(client).then(
      (next) => {
        if (current) setFound(next);
      },
      () => {
        if (current) setFound("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [client, online, unlocked, running]);

  useEffect(() => () => stop.current?.abort(), []);

  const start = async (files: Found["files"]) => {
    const controller = new AbortController();
    stop.current = controller;
    setReport(null);
    setStopping(false);
    setProgress({
      total: files.length,
      done: 0,
      converted: 0,
      kept: 0,
      failed: 0,
      before: 0,
      after: 0,
    });
    try {
      setReport(
        await convertImages({
          client,
          files,
          get allowance() {
            return latest.current;
          },
          fetchBodies: (noteIds) => engine()?.fetchBodies(noteIds) ?? Promise.resolve(),
          send: () => engine()?.kick(0),
          signal: controller.signal,
          onProgress: setProgress,
        }),
      );
    } catch {
      setReport("failed");
    } finally {
      if (stop.current === controller) stop.current = null;
      // Looked for again as it ends, and nothing offered meanwhile: what was
      // found before the run is not what is left.
      setFound("looking");
      setProgress(null);
    }
  };

  const lines: string[] = [];
  if (!progress) {
    if (report === "failed") lines.push(t.convert.runFailed);
    else if (report) lines.push(...said(report));
    if (!online) lines.push(t.convert.offline);
    else if (found === "looking") lines.push(t.convert.looking);
    else if (found === "failed") lines.push(t.convert.lookFailed);
    else if (found.files.length > 0) {
      lines.push(t.convert.found(found.files.length, formatBytes(found.bytes)), t.convert.note);
    } else if (!report && found.waitingForVault === 0) lines.push(t.convert.none);
    if (typeof found === "object" && found.waitingForVault > 0) {
      lines.push(t.convert.waitingForVault(found.waitingForVault));
    }
  }

  const ready = !progress && online && typeof found === "object" && found.files.length > 0;
  return (
    <section aria-labelledby={title} className="space-y-2 rounded-lg border p-3">
      <h3 id={title} className="text-sm font-medium">
        {t.convert.title}
      </h3>
      {/* How it went, read out once; how far it has come is not, at every image. */}
      <div
        role="status"
        aria-live="polite"
        className="space-y-1 text-xs leading-relaxed text-muted-foreground"
      >
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {progress ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{t.convert.progress(progress.done, progress.total)}</p>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={t.convert.title}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-valuetext={t.convert.progress(progress.done, progress.total)}
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          <p>{t.convert.keepOpen}</p>
        </div>
      ) : null}
      {progress ? (
        <Button
          variant="outline"
          size="sm"
          disabled={stopping}
          onClick={() => {
            // The image under way is finished first: said so meanwhile.
            setStopping(true);
            stop.current?.abort();
          }}
        >
          {stopping ? t.convert.stopping : t.convert.stop}
        </Button>
      ) : ready ? (
        <Button size="sm" onClick={() => void start(found.files)}>
          {t.convert.start}
        </Button>
      ) : null}
    </section>
  );
}

/** What a run came to, in plain words. */
function said(report: ConvertReport): string[] {
  const lines: string[] = [];
  if (report.converted > 0) {
    lines.push(
      t.convert.done(report.converted, formatBytes(report.before), formatBytes(report.after)),
    );
  }
  if (report.kept > 0) lines.push(t.convert.kept(report.kept));
  if (report.failed > 0) lines.push(t.convert.failed(report.failed));
  if (report.stopped === "cancelled") lines.push(t.convert.cancelled);
  if (report.stopped === "offline") lines.push(t.convert.stoppedOffline);
  if (report.stopped === "quota") lines.push(t.convert.quota);
  if (report.stopped === "unsent") lines.push(t.convert.unsent);
  return lines;
}
