"use client";

import { useMutation, useQuery } from "convex/react";
import { Fingerprint, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
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
  setUpVault,
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
  const { open, close } = useVaultUi();
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
  // One attempt at a time. Enter in the password field bypasses the disabled
  // button, and a second attempt finishing first would clear `busy` while the
  // first is still deriving a key or waiting for the server.
  const inFlight = useRef(false);

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

  // Only the server's answer decides between creating and opening. `undefined`
  // means that answer has not arrived yet, which must never read as "no vault":
  // offering to create one then is how an existing vault could be replaced.
  const loading = status === undefined;
  const creating = status === null;
  // While a key is being derived or saved, or the one-time recovery key is on
  // screen, closing would lose work that cannot be redone.
  const holdOpen = busy || freshKey !== null;

  const runSetup = async () => {
    if (password.length < MIN_PASSWORD) {
      setError(`パスワードは ${MIN_PASSWORD} 文字以上にしてください。`);
      return;
    }
    if (password !== confirm) {
      setError("2 つのパスワードが一致しません。");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await setUpVault(password, (record) => setup(record));
      if (result.status !== "ok") {
        // A vault already exists, made on another device or a moment ago in
        // another tab. Its key is the one every locked note uses.
        setPassword("");
        setConfirm("");
        setError("このアカウントにはすでに金庫があります。金庫のパスワードで開いてください。");
        return;
      }
      setFreshKey(grouped(result.recoveryKey));
      result.recoveryKey.fill(0);
    } catch {
      setError("設定できませんでした。時間をおいて試してください。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const runUnlock = async () => {
    if (!status || inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
  };

  const runBiometric = async () => {
    if (!status || status.passkeys.length === 0 || inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !holdOpen) close(vault.isUnlocked);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!holdOpen}
        onEscapeKeyDown={(event) => holdOpen && event.preventDefault()}
        onInteractOutside={(event) => holdOpen && event.preventDefault()}
      >
        {freshKey ? (
          // Each view is keyed so React builds fresh elements. Otherwise the
          // focused 設定する button is reused as 保管しました, and one more Enter
          // would dismiss the one-time key before it was read.
          <Fragment key="recovery">
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
          </Fragment>
        ) : loading ? (
          <Fragment key="loading">
            <DialogHeader>
              <DialogTitle>金庫の情報を読み込んでいます…</DialogTitle>
              <DialogDescription>しばらくお待ちください。</DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-4">
              <Loader2 className="text-muted-foreground size-5 animate-spin" aria-hidden />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                {t.action.cancel}
              </Button>
            </DialogFooter>
          </Fragment>
        ) : creating ? (
          <Fragment key="create">
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
              <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
                {t.action.cancel}
              </Button>
              <Button onClick={runSetup} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                設定する
              </Button>
            </DialogFooter>
          </Fragment>
        ) : (
          <Fragment key="unlock">
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
              <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
                {t.action.cancel}
              </Button>
              <Button onClick={runUnlock} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {t.vault.unlock}
              </Button>
            </DialogFooter>
          </Fragment>
        )}
      </DialogContent>
    </Dialog>
  );
}
