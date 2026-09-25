"use client";

import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
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
import { DEFAULT_ARGON } from "@/lib/crypto/primitives";
import { rewrapPasswordFromRaw, rewrapWithPassword } from "@/lib/crypto/vault";
import { useOnline } from "@/lib/hooks/use-online";
import { t } from "@/lib/i18n/ja";
import type { StoredVaultRecord } from "@/lib/vault/record";

const MIN_PASSWORD = 8;
const STALE = "ほかの端末で金庫の設定が変わりました。画面を閉じて、もう一度お試しください。";
const FAILED = "変更できませんでした。インターネット接続を確認して、もう一度お試しください。";

/**
 * Changes the vault password, knowing the current one. Only the wrapping of
 * the vault key changes, so nothing locked is encrypted again.
 */
export function ChangePasswordDialog({
  open,
  onOpenChange,
  record,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: StoredVaultRecord;
}) {
  const rewrap = useMutation(api.vault.rewrap);
  const online = useOnline();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The record the dialog opened on, fixed from then on: following later
  // versions would let this overwrite a change made on another device.
  const [base, setBase] = useState(record);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setCurrent("");
    setPassword("");
    setConfirm("");
    setError(null);
    if (open) setBase(record);
  }

  const save = async () => {
    if (current.length === 0) {
      setError("いまのパスワードを入力してください。");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`新しいパスワードは ${MIN_PASSWORD} 文字以上にしてください。`);
      return;
    }
    if (password !== confirm) {
      setError("2 つの新しいパスワードが一致しません。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let next;
      try {
        next = await rewrapWithPassword(base, current, password, DEFAULT_ARGON);
      } catch {
        // The only way unwrapping fails is the wrong password.
        setError("いまのパスワードが違います。");
        return;
      }
      const result = await rewrap({
        argon: next.argon,
        saltPw: next.saltPw,
        pwWrap: next.pwWrap,
        expectedVersion: base.version,
      });
      if (result.status === "stale") {
        setError(STALE);
        return;
      }
      if (result.status !== "ok") throw new Error(result.status);
      toast.success("金庫のパスワードを変更しました");
      onOpenChange(false);
    } catch {
      setError(FAILED);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!saving}
        onEscapeKeyDown={(event) => saving && event.preventDefault()}
        onInteractOutside={(event) => saving && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>金庫のパスワードを変更</DialogTitle>
          <DialogDescription>
            変えても、ロックしたメモを暗号化し直すことはありません。金庫の鍵の包み方だけが変わります。
          </DialogDescription>
        </DialogHeader>
        {!online ? (
          <p className="text-muted-foreground text-sm">
            オフラインのため、この設定はいま変更できません。
          </p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="change-current">いまのパスワード</Label>
              <Input
                id="change-current"
                type="password"
                value={current}
                autoComplete="current-password"
                onChange={(event) => setCurrent(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="change-password">新しいパスワード</Label>
              <Input
                id="change-password"
                type="password"
                value={password}
                autoComplete="new-password"
                aria-describedby="change-password-hint"
                onChange={(event) => setPassword(event.target.value)}
              />
              <p id="change-password-hint" className="text-muted-foreground text-xs">
                {MIN_PASSWORD} 文字以上
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="change-confirm">新しいパスワード（確認）</Label>
              <Input
                id="change-confirm"
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
                {t.action.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                変更する
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sets a new vault password without knowing the old one.
 *
 * The recovery key or this device's passkey proves who is asking and yields
 * the vault key, which is then wrapped under the new password. Only that one
 * wrapping changes, so nothing locked is encrypted again.
 */
export function ResetPasswordDialog({
  open,
  onOpenChange,
  record,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: StoredVaultRecord;
}) {
  const rewrap = useMutation(api.vault.rewrap);
  const online = useOnline();
  const [step, setStep] = useState<"auth" | "new">("auth");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [authing, setAuthing] = useState(false);
  const raw = useRef<Uint8Array | null>(null);
  // Read inside async work that may finish after the dialog has closed.
  const isOpen = useRef(open);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);
  // The version the dialog opened on, fixed from then on: following later
  // versions would let this overwrite a change made on another device.
  const [baseVersion, setBaseVersion] = useState(record.version);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setStep("auth");
    setPassword("");
    setConfirm("");
    setError(null);
    if (open) setBaseVersion(record.version);
  }

  // The vault key's bytes live only as long as this dialog needs them.
  const drop = () => {
    if (raw.current) wipe(raw.current);
    raw.current = null;
  };
  useEffect(() => {
    if (!open) drop();
  }, [open]);
  useEffect(() => drop, []);

  const save = async () => {
    if (!raw.current) return;
    if (password.length < MIN_PASSWORD) {
      setError(`新しいパスワードは ${MIN_PASSWORD} 文字以上にしてください。`);
      return;
    }
    if (password !== confirm) {
      setError("2 つの新しいパスワードが一致しません。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await rewrapPasswordFromRaw(raw.current, password);
      const result = await rewrap({
        argon: next.argon,
        saltPw: next.saltPw,
        pwWrap: next.pwWrap,
        expectedVersion: baseVersion,
      });
      if (result.status === "stale") {
        setError(STALE);
        return;
      }
      if (result.status !== "ok") throw new Error(result.status);
      toast.success("金庫のパスワードを再設定しました");
      onOpenChange(false);
    } catch {
      setError(FAILED);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !(saving || authing) && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!(saving || authing)}
        onEscapeKeyDown={(event) => (saving || authing) && event.preventDefault()}
        onInteractOutside={(event) => (saving || authing) && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>金庫のパスワードを再設定</DialogTitle>
          <DialogDescription>
            {step === "auth"
              ? "リカバリーキーか、この端末の Face ID / Touch ID で本人確認をしてから、新しいパスワードを決めます。"
              : "新しい金庫のパスワードを決めてください。"}
          </DialogDescription>
        </DialogHeader>

        {!online ? (
          <p className="text-muted-foreground text-sm">
            オフラインのため、この設定はいま変更できません。
          </p>
        ) : step === "auth" ? (
          <Reauth
            record={record}
            factors={["passkey", "recovery"]}
            submitLabel="続ける"
            onBusyChange={setAuthing}
            onRaw={async (bytes) => {
              if (!isOpen.current) {
                wipe(bytes);
                return;
              }
              drop();
              raw.current = bytes;
              setStep("new");
            }}
          />
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="reset-password">新しいパスワード</Label>
              <Input
                id="reset-password"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reset-confirm">新しいパスワード（確認）</Label>
              <Input
                id="reset-confirm"
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
                {t.action.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                再設定する
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
