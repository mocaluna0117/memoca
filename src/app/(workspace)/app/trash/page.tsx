"use client";

import { useConvex } from "convex/react";
import { Folder as FolderIcon, FileText, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { MobileHeader } from "@/components/shell/app-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useSync } from "@/components/providers/sync-provider";
import { type TrashEntry, useTrash } from "@/lib/hooks/data";
import { setFolderTrashed, setNoteTrashed } from "@/lib/sync/mutations";
import { t } from "@/lib/i18n/ja";

function TrashRow({ entry }: { entry: TrashEntry }) {
  const client = useConvex();
  const [busy, setBusy] = useState(false);
  const Icon = entry.kind === "folder" ? FolderIcon : FileText;

  const restore = async () => {
    setBusy(true);
    if (entry.kind === "folder") await setFolderTrashed(entry.id, false);
    else await setNoteTrashed(entry.id, false);
    setBusy(false);
    toast.success("復元しました");
  };

  const purge = async () => {
    setBusy(true);
    await client.mutation(api.trash.purge, {
      folderIds: entry.kind === "folder" ? [entry.id] : [],
      noteIds: entry.kind === "note" ? [entry.id] : [],
    });
    setBusy(false);
    toast.success("完全に削除しました");
  };

  return (
    <li className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{entry.label}</p>
        <p className="text-muted-foreground text-xs">
          {new Date(entry.deletedAt).toLocaleDateString("ja-JP")} に削除
          {entry.kind === "folder" ? "・中身もいっしょに戻ります" : ""}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={restore} disabled={busy} className="gap-1.5">
        <RotateCcw className="size-3.5" aria-hidden />
        {t.action.restore}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={purge}
        disabled={busy}
        className="text-destructive hover:text-destructive"
      >
        {t.action.deleteForever}
      </Button>
    </li>
  );
}

export default function TrashPage() {
  const entries = useTrash();
  const client = useConvex();
  const { me } = useSync();
  const [confirming, setConfirming] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const emptyAll = async () => {
    setEmptying(true);
    await client.mutation(api.trash.purge, {
      folderIds: entries.filter((e) => e.kind === "folder").map((e) => e.id),
      noteIds: entries.filter((e) => e.kind === "note").map((e) => e.id),
    });
    setEmptying(false);
    setConfirming(false);
    toast.success("ゴミ箱を空にしました");
  };

  return (
    <div className="flex flex-1 flex-col">
      <MobileHeader title={t.nav.trash} />
      <div className="mx-auto w-full max-w-3xl flex-1 px-0 sm:px-6 sm:py-6">
        <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-0">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t.nav.trash}</h1>
            <p className="text-muted-foreground text-sm">
              削除から {me?.settings.trashRetentionDays ?? 30} 日を過ぎたものは自動で消えます。
            </p>
          </div>
          {entries.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              <Trash2 className="size-4" aria-hidden />
              {t.action.emptyTrash}
            </Button>
          ) : null}
        </div>

        {entries.length === 0 ? (
          <p className="text-muted-foreground px-4 py-16 text-center text-sm sm:px-0">
            {t.empty.trashEmpty}
          </p>
        ) : (
          <ul className="bg-card rounded-none border-y sm:rounded-lg sm:border">
            {entries.map((entry) => (
              <TrashRow key={`${entry.kind}:${entry.id}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>ゴミ箱を空にしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {entries.length} 件を完全に削除します。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.action.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={emptyAll} disabled={emptying}>
              {emptying ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              完全に削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
