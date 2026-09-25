"use client";

import { Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PasskeyCancelledError,
  PasskeyNeedsRetryError,
  PrfUnsupportedError,
  platformAuthenticatorAvailable,
  startPasskey,
} from "@/lib/crypto/passkey";
import { RECOVERY_KEY_LENGTH, parseRecoveryKey } from "@/lib/crypto/recovery-key";
import { openVaultRaw } from "@/lib/crypto/vault";
import { t } from "@/lib/i18n/ja";
import { localPasskeyIds, rememberLocalPasskey } from "@/lib/vault/local-passkeys";
import type { StoredVaultRecord } from "@/lib/vault/record";

export type ReauthFactor = "passkey" | "password" | "recovery";

/**
 * Proves who is asking and hands back the raw vault key.
 *
 * Replacing the recovery key or the password needs the key's bytes, which the
 * open session deliberately cannot give out, so they are derived again from a
 * factor proved here. The caller owns the bytes it receives and must wipe
 * them.
 */
export function Reauth({
  record,
  factors,
  submitLabel,
  onRaw,
  onBusyChange,
}: {
  record: StoredVaultRecord;
  factors: ReauthFactor[];
  submitLabel: string;
  onRaw: (raw: Uint8Array) => Promise<void>;
  /**
   * Reports when a key is being derived or passed on, so the dialog around
   * this can refuse to close: closing mid-way would still finish the work
   * without anyone seeing the result.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const typed = factors.filter((factor) => factor !== "passkey");
  const [mode, setMode] = useState<"password" | "recovery">(
    typed.includes("password") ? "password" : "recovery",
  );
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState(false);
  const inFlight = useRef(false);
  const [retryPasskey, setRetryPasskey] = useState<string | null>(null);
  const passkeyAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    void platformAuthenticatorAvailable().then(setPlatform);
    // A sheet still showing when this goes away would unlock nothing useful.
    return () => passkeyAbort.current?.abort();
  }, []);

  const passkeyReady =
    factors.includes("passkey") && platform && record.passkeys.length > 0;

  const finish = async (derive: () => Promise<Uint8Array>, failure: string) => {
    let raw: Uint8Array;
    try {
      raw = await derive();
    } catch (cause) {
      if (cause instanceof PasskeyCancelledError) return;
      if (cause instanceof PasskeyNeedsRetryError) {
        setRetryPasskey(cause.credentialId);
        setError("もう一度 Face ID / Touch ID で確認してください。");
        return;
      }
      setError(cause instanceof PrfUnsupportedError ? cause.message : failure);
      return;
    }
    await onRaw(raw);
  };

  const withBusy = (run: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    void run().finally(() => {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    });
  };

  const usePasskey = () =>
    withBusy(() => {
      const controller = new AbortController();
      passkeyAbort.current = controller;
      // Started before anything is awaited, so the tap still counts for it.
      const asking = startPasskey(record.passkeys, localPasskeyIds(), {
        signal: controller.signal,
        only: retryPasskey ?? undefined,
      });
      return finish(async () => {
        const { entry, output } = await asking;
        const full = record.passkeys.find((p) => p.credentialId === entry.credentialId)!;
        const raw = await openVaultRaw(record, { prf: { entry: full, output } });
        void rememberLocalPasskey(entry.credentialId);
        setRetryPasskey(null);
        return raw;
      }, "Face ID / Touch ID で確認できませんでした。ほかの方法を使ってください。");
    });

  const submit = () =>
    withBusy(async () => {
      if (mode === "password") {
        await finish(
          () => openVaultRaw(record, { password: value }),
          t.vault.wrongPassword,
        );
        return;
      }
      const parsed = parseRecoveryKey(value);
      if (!parsed.ok) {
        setError(
          parsed.reason === "legacy"
            ? "このリカバリーキーは、以前の不具合で一部しか表示されていなかったため使えません。"
            : `リカバリーキーは ${RECOVERY_KEY_LENGTH} 文字です（いま ${parsed.length} 文字）。`,
        );
        return;
      }
      await finish(
        () => openVaultRaw(record, { recoveryKey: parsed.key }),
        "このリカバリーキーでは開けません。",
      );
    });

  return (
    <div className="space-y-3">
      {passkeyReady ? (
        <Button className="w-full gap-2" onClick={usePasskey} disabled={busy}>
          <Fingerprint className="size-4" aria-hidden />
          Face ID / Touch ID で続ける
        </Button>
      ) : null}

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {mode === "password" ? (
          <>
            <Label htmlFor="reauth-password">{t.vault.password}</Label>
            <Input
              id="reauth-password"
              type="password"
              value={value}
              autoComplete="current-password"
              onChange={(event) => setValue(event.target.value)}
            />
          </>
        ) : (
          <>
            <Label htmlFor="reauth-recovery">{t.vault.recoveryKey}</Label>
            <Input
              id="reauth-recovery"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={`XXXX-XXXX-XXXX-…（${RECOVERY_KEY_LENGTH} 文字）`}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono"
            />
          </>
        )}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          {typed.length > 1 ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs"
              onClick={() => {
                setMode(mode === "password" ? "recovery" : "password");
                setValue("");
                setError(null);
              }}
            >
              <KeyRound className="size-3.5" aria-hidden />
              {mode === "password" ? "リカバリーキーを使う" : "パスワードを使う"}
            </button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            variant={passkeyReady ? "outline" : "default"}
            disabled={busy || value.length === 0}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
