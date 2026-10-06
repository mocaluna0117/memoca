"use client";

import { useConvex } from "convex/react";
import { History, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type * as Y from "yjs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  type VersionRow,
  VersionUnavailableError,
  listVersions,
  openVersion,
  restoreVersion,
} from "@/lib/sync/versions";
import { extractText } from "@/lib/sync/ydoc";

const when = (at: number) =>
  new Date(at).toLocaleString("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** How long ago, in words: たった今, 5 分前, 3 時間前, 2 日前. */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  return `${Math.floor(hours / 24)} 日前`;
}

/** Why a version cannot be shown, in words. */
function unavailable(error: unknown): string {
  if (error instanceof VersionUnavailableError) {
    if (error.reason === "vaultClosed") return "ロックしたメモの版は、金庫を開くと見られます。";
    if (error.reason === "otherKey") return "ロックし直す前の版のため、開けません。";
  }
  return navigator.onLine
    ? "この版を読み込めませんでした。"
    : "変更履歴は、インターネットにつながっているときに見られます。";
}

/**
 * 変更履歴: the versions of a note kept on the server (lib/sync/versions),
 * newest first; one picked shows its text, and is put back with この版に戻す.
 */
export function VersionHistory({
  noteId,
  open,
  onOpenChange,
}: {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Made anew each time it opens: the versions as they are then. */}
      {open ? (
        <VersionList key={noteId} noteId={noteId} onDone={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  );
}

type Shown = { versionId: string } & ({ doc: Y.Doc; text: string } | { error: string });

function VersionList({ noteId, onDone }: { noteId: string; onDone: () => void }) {
  const client = useConvex();
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<VersionRow | null>(null);
  const [loaded, setLoaded] = useState<Shown | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [now] = useState(() => Date.now());
  // The one picked, once it is read: one read for another picked before stays out.
  const shown = loaded && picked && loaded.versionId === picked.versionId ? loaded : null;

  useEffect(() => {
    let current = true;
    listVersions(client, noteId).then(
      (rows) => current && setVersions(rows),
      () => current && setFailed(unavailable(null)),
    );
    return () => {
      current = false;
    };
  }, [client, noteId]);

  useEffect(() => {
    if (!picked) return;
    let current = true;
    const { versionId } = picked;
    openVersion(client, versionId).then(
      (doc) => {
        if (current) setLoaded({ versionId, doc, text: extractText(doc) });
        else doc.destroy();
      },
      (error: unknown) => current && setLoaded({ versionId, error: unavailable(error) }),
    );
    return () => {
      current = false;
    };
  }, [client, picked]);

  const restore = async () => {
    if (!shown || !("doc" in shown) || restoring) return;
    setRestoring(true);
    try {
      await restoreVersion(client, noteId, shown.doc);
      toast.success("この版に戻しました", {
        description: "戻す前の内容も変更履歴に残っています。",
      });
      onDone();
    } catch {
      toast.error("戻せませんでした。もう一度お試しください。");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>変更履歴</DialogTitle>
          <DialogDescription>
            編集しているあいだ、10 分ごとにその時点の本文を残しています。古いものほど間引かれ、30
            日たつと消えます。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-3 sm:grid-cols-[14rem_1fr]">
          <ul
            className="max-h-48 space-y-0.5 overflow-y-auto sm:max-h-96"
            aria-label="残っている版"
          >
            {failed ? <li className="p-2 text-sm text-muted-foreground">{failed}</li> : null}
            {!failed && versions === null ? (
              <li className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> 読み込み中…
              </li>
            ) : null}
            {versions?.length === 0 ? (
              <li className="p-2 text-sm text-muted-foreground">
                まだ残っている版はありません。このメモを編集すると、残るようになります。
              </li>
            ) : null}
            {versions?.map((version) => (
              <li key={version.versionId}>
                <button
                  type="button"
                  onClick={() => setPicked(version)}
                  aria-pressed={picked?.versionId === version.versionId}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    picked?.versionId === version.versionId && "bg-accent",
                  )}
                >
                  <span className="block">{when(version.createdAt)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {ago(version.createdAt, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="max-h-72 min-h-32 overflow-y-auto rounded-md border bg-muted/40 p-3 sm:max-h-96">
            {!picked ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <History className="size-4" aria-hidden />{" "}
                左から版を選ぶと、その時点の本文が出ます。
              </p>
            ) : shown === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> 読み込み中…
              </p>
            ) : "error" in shown ? (
              <p className="text-sm text-muted-foreground">{shown.error}</p>
            ) : (
              <p className="text-sm whitespace-pre-wrap" data-testid="version-text">
                {shown.text || "（本文は空です）"}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => void restore()}
            disabled={!shown || !("doc" in shown) || restoring}
            className="gap-1.5"
          >
            {restoring ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            この版に戻す
          </Button>
        </DialogFooter>
      </DialogContent>
    </>
  );
}
