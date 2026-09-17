"use client";

import { useMutation, useQuery } from "convex/react";
import { Fingerprint, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
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
import { fromBase32, toBase32 } from "@/lib/bytes";
import {
  PrfUnsupportedError,
  evaluatePrf,
  platformAuthenticatorAvailable,
} from "@/lib/crypto/passkey";
import {
  createVault,
  unlockWithPassword,
  unlockWithPrf,
  unlockWithRecoveryKey,
  vault,
} from "@/lib/crypto/vault";
import { useVaultUi } from "@/lib/store/vault-ui";
import { t } from "@/lib/i18n/ja";

const MIN_PASSWORD = 8;

/** Formats the recovery key in groups so it can be written down accurately. */
function grouped(key: Uint8Array): string {
  return (
    toBase32(key)
      .slice(0, 40)
      .match(/.{1,5}/g) ?? []
  ).join("-");
}

export function VaultDialog() {
  const { open, mode, close } = useVaultUi();
  const status = useQuery(api.vault.status, open ? {} : "skip");
  const setup = useMutation(api.vault.setup);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [biometricReady, setBiometricReady] = useState(false);

  // Clear the form the moment the dialog closes, so a password never lingers
  // in memory behind a closed sheet.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setPassword("");
      setConfirm("");
      setRecoveryInput("");
      setUseRecovery(false);
      setError(null);
      setFreshKey(null);
    }
  }

  useEffect(() => {
    void platformAuthenticatorAvailable().then(setBiometricReady);
  }, []);

  const creating = mode === "setup" || status === null;

  const runSetup = async () => {
    if (password.length < MIN_PASSWORD) {
      setError(`パスワードは ${MIN_PASSWORD} 文字以上にしてください。`);
      return;
    }
    if (password !== confirm) {
      setError("2 つのパスワードが一致しません。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { record, recoveryKey } = await createVault(password);
      await setup({
        argon: record.argon,
        saltPw: record.saltPw,
        pwWrap: record.pwWrap,
        recWrap: record.recWrap,
      });
      setFreshKey(grouped(recoveryKey));
      recoveryKey.fill(0);
    } catch {
      setError("設定できませんでした。時間をおいて試してください。");
    } finally {
      setBusy(false);
    }
  };

  const runUnlock = async () => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      if (useRecovery) {
        await unlockWithRecoveryKey(status, fromBase32(recoveryInput));
      } else {
        await unlockWithPassword(status, password);
      }
      close(true);
    } catch {
      setError(useRecovery ? "リカバリーキーが正しくありません。" : t.vault.wrongPassword);
    } finally {
      setBusy(false);
    }
  };

  const runBiometric = async () => {
    if (!status || status.passkeys.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let lastError: unknown = null;
      for (const entry of status.passkeys) {
        try {
          const output = await evaluatePrf(
            entry.credentialId,
            new Uint8Array(entry.prfInput),
          );
          await unlockWithPrf(entry, output);
          close(true);
          return;
        } catch (cause) {
          lastError = cause;
        }
      }
      setError(
        lastError instanceof PrfUnsupportedError
          ? lastError.message
          : "生体認証で解除できませんでした。パスワードをお試しください。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close(vault.isUnlocked)}>
      <DialogContent className="sm:max-w-md">
        {freshKey ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="size-5" aria-hidden />
                リカバリーキーを保管してください
              </DialogTitle>
              <DialogDescription>
                パスワードを忘れたときに、ロックしたメモを開ける唯一の手段です。
                これは一度しか表示されません。私たちも復元できません。
              </DialogDescription>
            </DialogHeader>
            <p className="bg-muted rounded-md p-4 text-center font-mono text-sm tracking-wider break-all select-all">
              {freshKey}
            </p>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(freshKey);
                  toast.success(t.action.copied);
                }}
              >
                {t.action.copy}
              </Button>
              <Button onClick={() => close(true)}>保管しました</Button>
            </DialogFooter>
          </>
        ) : creating ? (
          <>
            <DialogHeader>
              <DialogTitle>{t.vault.setupTitle}</DialogTitle>
              <DialogDescription>
                ロックしたメモは、このパスワードから作った鍵で端末の中だけで暗号化されます。
                サーバーには暗号文しか届きません。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="vault-password">{t.vault.password}</Label>
                <Input
                  id="vault-password"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vault-confirm">{t.vault.passwordAgain}</Label>
                <Input
                  id="vault-confirm"
                  type="password"
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </div>
              {error ? <p className="text-destructive text-sm">{error}</p> : null}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                {t.action.cancel}
              </Button>
              <Button onClick={runSetup} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                設定する
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t.vault.unlock}</DialogTitle>
              <DialogDescription>
                ロックしたメモを開くために、金庫を解除します。
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              {biometricReady && status && status.passkeys.length > 0 ? (
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={runBiometric}
                  disabled={busy}
                >
                  <Fingerprint className="size-4" aria-hidden />
                  {t.vault.biometric}
                </Button>
              ) : null}

              {useRecovery ? (
                <div className="space-y-1.5">
                  <Label htmlFor="vault-recovery">{t.vault.recoveryKey}</Label>
                  <Input
                    id="vault-recovery"
                    value={recoveryInput}
                    onChange={(event) => setRecoveryInput(event.target.value)}
                    placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                    autoCapitalize="characters"
                    className="font-mono"
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="vault-unlock-password">{t.vault.password}</Label>
                  <Input
                    id="vault-unlock-password"
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    autoFocus
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void runUnlock()}
                  />
                </div>
              )}

              {error ? <p className="text-destructive text-sm">{error}</p> : null}

              <button
                type="button"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setError(null);
                }}
              >
                <KeyRound className="size-3.5" aria-hidden />
                {useRecovery ? "パスワードで解除する" : "リカバリーキーで解除する"}
              </button>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                {t.action.cancel}
              </Button>
              <Button onClick={runUnlock} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {t.vault.unlock}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
