"use client";

import { useConvex } from "convex/react";
import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { exportAll } from "@/lib/export/archive";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { downloadFile } from "@/lib/media/open-file";

/**
 * 書き出し: every note as Markdown, with its files, in one ZIP, saved on
 * this device (see exportAll). Locked notes go in only when asked for,
 * with the vault open, as the archive is not encrypted.
 */
export function ExportAll() {
  const client = useConvex();
  const { engine } = useSync();
  const unlocked = useVaultUnlocked();
  const [includeLocked, setIncludeLocked] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const run = async () => {
    if (progress) return;
    setProgress({ done: 0, total: 0 });
    try {
      const sync = engine();
      const result = await exportAll({
        client,
        fetchBodies: sync ? (ids) => sync.fetchBodies(ids) : undefined,
        includeLocked: includeLocked && unlocked,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      const url = URL.createObjectURL(result.archive);
      try {
        const saved = await downloadFile(url, result.name);
        if (saved.kind === "ready") {
          toast("書き出しの準備ができました", {
            duration: 30_000,
            action: { label: "保存", onClick: () => void saved.share() },
          });
        }
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      const notes: string[] = [];
      if (result.lockedLeftOut > 0)
        notes.push(`ロックしたメモ ${result.lockedLeftOut} 件は含めていません。`);
      if (result.filesMissing > 0) {
        notes.push(`この端末にないファイル ${result.filesMissing} 件は含められませんでした。`);
      }
      if (result.notesBehind > 0) {
        notes.push(
          `${result.notesBehind} 件のメモは、最新の内容を取得できず、この端末にある内容で書き出しました。`,
        );
      }
      toast.success(`メモ ${result.notes} 件とファイル ${result.files} 件を書き出しました`, {
        description: notes.join(" ") || undefined,
        duration: notes.length > 0 ? 15_000 : 5_000,
      });
    } catch (error) {
      console.error("Could not export", error);
      toast.error("書き出せませんでした。もう一度お試しください。");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Switch
          id="export-locked"
          checked={includeLocked && unlocked}
          disabled={!unlocked || progress !== null}
          onCheckedChange={setIncludeLocked}
        />
        <Label htmlFor="export-locked" className="text-sm font-normal">
          ロックしたメモも含める
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {unlocked
          ? "含めると、ロックしたメモも誰でも読める形で書き出されます。保存先に気をつけてください。"
          : "ロックしたメモを含めるには、先に金庫を開いてください。"}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => void run()}
        aria-disabled={progress !== null}
      >
        {progress ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Download className="size-3.5" aria-hidden />
        )}
        {progress
          ? progress.total > 0
            ? `書き出し中… ${progress.done} / ${progress.total}`
            : "準備中…"
          : "すべてのメモを書き出す"}
      </Button>
    </div>
  );
}
