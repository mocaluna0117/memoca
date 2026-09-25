"use client";

import { useMutation } from "convex/react";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { RecoveryKeyView, recordKeptKey } from "@/components/vault/recovery-key-view";
import { Reauth } from "@/components/vault/reauth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { wipe } from "@/lib/crypto/primitives";
import {
  RECOVERY_FORMAT,
  RECOVERY_KEY_LENGTH,
  formatRecoveryKey,
  parseRecoveryKey,
} from "@/lib/crypto/recovery-key";
import { issueRecoveryWrap, verifyRecoveryKey } from "@/lib/crypto/vault";
import { useOnline } from "@/lib/hooks/use-online";
import { t } from "@/lib/i18n/ja";
import { type StoredVaultRecord, useVaultRecord } from "@/lib/vault/record";

/** Whether this vault's recovery key needs replacing, and why. */
export function recoveryKeyState(record: StoredVaultRecord): "legacy" | "unconfirmed" | "ok" {
  if (record.recoveryFormat !== RECOVERY_FORMAT) return "legacy";
  if (record.recoveryCheckedAt === null) return "unconfirmed";
  return "ok";
}

export function RecoverySettings() {
  const record = useVaultRecord((s) => s.record);
  const [reissuing, setReissuing] = useState(false);
  const [testing, setTesting] = useState(false);
  if (!record) return null;
  const state = recoveryKeyState(record);

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        金庫のパスワードを忘れたときに金庫を開くためのキーです。
      </p>

      {state === "legacy" ? (
        <div role="alert" className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <TriangleAlert className="text-destructive size-4" aria-hidden />
            リカバリーキーを作り直してください
          </p>
          <p className="text-muted-foreground text-sm">
            以前に表示されたリカバリーキーは、表示の不具合で一部が欠けていたため、金庫を開けません。新しいキーを作って保管してください。
          </p>
          <Button size="sm" onClick={() => setReissuing(true)}>
            いますぐ作り直す
          </Button>
        </div>
      ) : state === "unconfirmed" ? (
        <div role="status" className="space-y-1 rounded-md border p-3">
          <p className="text-sm font-medium">リカバリーキーの保管が確認できていません</p>
          <p className="text-muted-foreground text-sm">
            作成時の確認が終わっていません。念のため新しいキーを作って保管してください。
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {new Date(record.recoveryCheckedAt!).toLocaleDateString("ja-JP")} に保管を確認済み
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setReissuing(true)}>
          リカバリーキーを作り直す
        </Button>
        <Button variant="outline" size="sm" onClick={() => setTesting(true)}>
          リカバリーキーを試す
        </Button>
      </div>

      <ReissueDialog open={reissuing} onOpenChange={setReissuing} record={record} />
      <TestKeyDialog open={testing} onOpenChange={setTesting} record={record} />
    </div>
  );
}

/**
 * Makes a new recovery key. It is saved to the server before it is shown, so
 * the key on screen is always one the vault accepts, and it replaces only the
 * recovery wrapping: nothing locked is encrypted again.
 */
function ReissueDialog({
  open,
  onOpenChange,
  record,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: StoredVaultRecord;
}) {
  const rewrap = useMutation(api.vault.rewrap);
  const markChecked = useMutation(api.vault.markRecoveryChecked);
  const online = useOnline();
  const [shown, setShown] = useState<{ key: string; iv: ArrayBuffer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [authing, setAuthing] = useState(false);
  // Read inside async work that may finish after the dialog has closed.
  const isOpen = useRef(open);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);
  // The version this dialog started from: a change made on another device in
  // the meantime must not be overwritten.
  const [baseVersion, setBaseVersion] = useState(record.version);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setShown(null);
      setError(null);
      setBaseVersion(record.version);
    }
  }

  // Closing while a key is being derived or saved would still replace the
  // recovery key, with the new one never shown: the old key would stop
  // working and nobody would have the new one.
  const holdOpen = authing || saving || shown !== null;

  const onRaw = async (raw: Uint8Array) => {
    if (!isOpen.current) {
      wipe(raw);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { recWrap, recoveryKey } = await issueRecoveryWrap(raw);
      if (!isOpen.current) {
        wipe(recoveryKey);
        return;
      }
      const result = await rewrap({
        recWrap,
        recoveryFormat: RECOVERY_FORMAT,
        expectedVersion: baseVersion,
      });
      if (result.status === "stale") {
        setError("ほかの端末で金庫の設定が変わりました。画面を閉じて、もう一度お試しください。");
        return;
      }
      if (result.status !== "ok") {
        setError("保存できませんでした。インターネット接続を確認して、もう一度お試しください。");
        return;
      }
      setShown({ key: formatRecoveryKey(recoveryKey), iv: recWrap.iv });
      wipe(recoveryKey);
    } catch {
      setError("保存できませんでした。インターネット接続を確認して、もう一度お試しください。");
    } finally {
      wipe(raw);
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !holdOpen && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!holdOpen}
        onEscapeKeyDown={(event) => holdOpen && event.preventDefault()}
        onInteractOutside={(event) => holdOpen && event.preventDefault()}
      >
        {shown ? (
          <RecoveryKeyView
            recoveryKey={shown.key}
            onConfirmed={async () => {
              const outcome = await recordKeptKey(() => markChecked({ recWrapIv: shown.iv }));
              if (outcome === "stale") {
                toast.error(
                  "ほかの端末でリカバリーキーが作り直されました。このキーは使えません。もう一度作り直してください。",
                );
              } else {
                toast.success("新しいリカバリーキーを保存しました");
              }
              setShown(null);
              onOpenChange(false);
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>リカバリーキーを作り直す</DialogTitle>
              <DialogDescription>
                新しいキーを作ると、いまのリカバリーキーは使えなくなります。続けるには本人確認をしてください。
              </DialogDescription>
            </DialogHeader>
            {online ? (
              <Reauth
                record={record}
                factors={["passkey", "password"]}
                submitLabel="続ける"
                onRaw={onRaw}
                onBusyChange={setAuthing}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                リカバリーキーの作り直しにはインターネット接続が必要です。
              </p>
            )}
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Checks a kept recovery key against the vault without opening it. */
function TestKeyDialog({
  open,
  onOpenChange,
  record,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: StoredVaultRecord;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setValue("");
      setResult(null);
    }
  }

  const check = async () => {
    const parsed = parseRecoveryKey(value);
    if (!parsed.ok) {
      setResult({
        ok: false,
        text:
          parsed.reason === "legacy"
            ? "このリカバリーキーは、以前の不具合で一部しか表示されていなかったため使えません。"
            : `リカバリーキーは ${RECOVERY_KEY_LENGTH} 文字です（いま ${parsed.length} 文字）。`,
      });
      return;
    }
    setBusy(true);
    try {
      const ok = await verifyRecoveryKey(record, parsed.key);
      setResult(
        ok
          ? { ok: true, text: "このリカバリーキーは使えます。" }
          : { ok: false, text: "このリカバリーキーでは開けません。" },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>リカバリーキーを試す</DialogTitle>
          <DialogDescription>
            保管したリカバリーキーを入力すると、使えるかどうかを確かめます。金庫は開きません。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          <Label htmlFor="test-recovery">{t.vault.recoveryKey}</Label>
          <Input
            id="test-recovery"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setResult(null);
            }}
            placeholder={`XXXX-XXXX-XXXX-…（${RECOVERY_KEY_LENGTH} 文字）`}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
          />
          {result ? (
            <p
              role="status"
              className={result.ok ? "text-sm text-green-700 dark:text-green-400" : "text-destructive text-sm"}
            >
              {result.text}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t.action.close}
            </Button>
            <Button type="submit" disabled={busy || value.trim().length === 0}>
              試す
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
