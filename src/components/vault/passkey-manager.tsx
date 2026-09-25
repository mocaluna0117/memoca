"use client";

import { useMutation } from "convex/react";
import { Fingerprint, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { PasskeyEnrollDialog } from "@/components/vault/passkey-enroll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { withMethod } from "@/lib/crypto/platform";
import { useOnline } from "@/lib/hooks/use-online";
import {
  forgetLocalPasskey,
  useLocalPasskeyIds,
  usePlatformPasskey,
} from "@/lib/vault/local-passkeys";
import { useVaultRecord } from "@/lib/vault/record";
import { useUnlockMethod } from "@/lib/vault/use-vault-labels";

type Entry = { credentialId: string; label: string; createdAt: number };

/**
 * The passkeys that can open the vault, and registering this device's.
 *
 * Each passkey's PRF output wraps the same vault key the password already
 * wraps, so this adds a convenient way in without becoming the only one:
 * losing the phone still leaves the password and the recovery key.
 */
export function PasskeyManager() {
  const record = useVaultRecord((s) => s.record);
  const platform = usePlatformPasskey();
  const method = useUnlockMethod();
  const online = useOnline();
  const local = useLocalPasskeyIds();
  const [enrolling, setEnrolling] = useState(false);
  const [removing, setRemoving] = useState<Entry | null>(null);

  if (!record) return null;

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        登録すると、パスワードを入力せずに Face ID や Touch ID
        で金庫を開けます。パスキーは端末のパスワード管理（iCloud キーチェーンや Google
        パスワードマネージャー）に「Memoca の金庫」として保存されます。
      </p>

      {record.passkeys.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {record.passkeys.map((entry) => (
            <li key={entry.credentialId} className="flex items-center gap-3 px-3 py-2">
              <Fingerprint className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm">
                  <span className="truncate">{entry.label}</span>
                  {local.includes(entry.credentialId) ? (
                    <Badge variant="secondary">この端末</Badge>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-xs">
                  {new Date(entry.createdAt).toLocaleDateString("ja-JP")} に登録
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${entry.label} のパスキーを削除`}
                onClick={() => setRemoving(entry)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {platform ? (
        <Button variant="outline" onClick={() => setEnrolling(true)} disabled={!online} className="gap-2">
          <Fingerprint className="size-4" aria-hidden />
          {withMethod(`この端末で ${method}`, "を使う")}
        </Button>
      ) : (
        <p className="text-muted-foreground text-sm">
          この端末ではパスキー（Face ID など）を使えません。金庫はパスワードで開けます。
        </p>
      )}

      <PasskeyEnrollDialog
        open={enrolling}
        onOpenChange={setEnrolling}
        record={record}
        onDone={(result) =>
          toast.success(
            result === "added"
              ? withMethod(`この端末で ${method}`, "を使えるようにしました")
              : "この端末のパスキーを使えるようにしました",
          )
        }
      />
      <RemoveDialog entry={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

function RemoveDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const remove = useMutation(api.vault.removePasskey);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const result = await remove({ credentialId: entry.credentialId });
      if (result.status !== "ok") throw new Error(result.status);
      await forgetLocalPasskey(entry.credentialId);
      toast.success("パスキーを削除しました");
      onClose();
    } catch {
      toast.error("削除できませんでした。インターネット接続を確認してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>「{entry?.label}」のパスキーを削除しますか？</DialogTitle>
          <DialogDescription>
            この登録では金庫を開けなくなります。金庫のパスワードとリカバリーキーはそのまま使えます。端末のパスワード管理に残るパスキーは、必要なら端末の設定から削除してください。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            削除する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
