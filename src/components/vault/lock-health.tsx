"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RenameDialog } from "@/components/folders/rename-dialog";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { renameFolder, setNoteTrashed } from "@/lib/sync/mutations";
import { readVaultHealth } from "@/lib/vault/reconcile";

/**
 * Notes and folder names the vault's key could not open when last checked.
 *
 * An earlier bug could lock things under a key that was never saved. They
 * are not deleted automatically: the person sees them here, and chooses.
 */
export function LockHealth() {
  const data = useLiveQuery(async () => {
    const health = await readVaultHealth();
    if (!health) return null;
    const notes = (await db().notes.bulkGet(health.unreadableNotes)).filter(
      (note) => note && !note.purged && note.deletedAt === null,
    );
    const folders = (await db().folders.bulkGet(health.unreadableFolders)).filter(
      (folder) => folder && !folder.purged && folder.name === null,
    );
    const names = new Map((await db().folders.toArray()).map((f) => [f.folderId, f.name]));
    return { notes: notes.map((n) => n!), folders: folders.map((f) => f!), names };
  }, []);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  if (!data || (data.notes.length === 0 && data.folders.length === 0)) return null;

  return (
    <div role="alert" className="border-destructive/40 bg-destructive/5 space-y-3 rounded-md border p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <TriangleAlert className="text-destructive size-4" aria-hidden />
        開けないメモがあります
      </p>
      {data.notes.length > 0 ? (
        <>
          <p className="text-muted-foreground text-sm">
            {data.notes.length}{" "}
            件のメモが、この金庫の鍵では開けません。以前の不具合で、別の鍵でロックされた可能性があります。メモは削除されていません。
          </p>
          {open ? (
            <ul className="divide-y rounded-md border bg-background">
              {data.notes.map((note) => (
                <li key={note.noteId} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {note.folderId ? (data.names.get(note.folderId) ?? "フォルダ") : "フォルダなし"}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {new Date(note.updatedAt).toLocaleString("ja-JP")} に更新
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await setNoteTrashed(note.noteId, true);
                      toast("ゴミ箱に移動しました", {
                        action: {
                          label: "元に戻す",
                          onClick: () => void setNoteTrashed(note.noteId, false),
                        },
                      });
                    }}
                  >
                    ゴミ箱に移動
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              一覧を見る
            </Button>
          )}
        </>
      ) : null}
      {data.folders.length > 0 ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            名前を読めないフォルダが {data.folders.length} 件あります。
          </p>
          <Button size="sm" variant="outline" onClick={() => setRenaming(data.folders[0]!.folderId)}>
            名前を付け直す
          </Button>
        </div>
      ) : null}
      <RenameDialog
        open={renaming !== null}
        title="フォルダの名前を付け直す"
        initialValue=""
        onOpenChange={(next) => !next && setRenaming(null)}
        onSubmit={async (value) => {
          if (renaming) await renameFolder(renaming, value);
          setRenaming(null);
        }}
      />
    </div>
  );
}
