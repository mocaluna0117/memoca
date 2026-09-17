"use client";

import { useMutation, useQuery } from "convex/react";
import { Fingerprint, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toArrayBuffer } from "@/lib/bytes";
import {
  PrfUnsupportedError,
  platformAuthenticatorAvailable,
  registerPasskey,
} from "@/lib/crypto/passkey";
import { extractVaultRaw, wrapForPasskey } from "@/lib/crypto/vault";

/**
 * Registers Face ID / Touch ID as a way into the vault.
 *
 * The passkey's PRF output wraps the same vault key the password already wraps,
 * so this adds a convenient route without becoming a single point of failure:
 * losing the phone still leaves the password and the recovery key.
 */
export function PasskeyManager() {
  const { me } = useSync();
  const status = useQuery(api.vault.status);
  const addPasskey = useMutation(api.vault.addPasskey);
  const removePasskey = useMutation(api.vault.removePasskey);

  const [available, setAvailable] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void platformAuthenticatorAvailable().then(setAvailable);
  }, []);

  if (!status) {
    return (
      <p className="text-muted-foreground text-sm">
        先にロックを設定すると、生体認証を登録できます。
      </p>
    );
  }

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      // The session key is deliberately non-extractable, so the raw bytes are
      // re-derived from the password the user just typed.
      const raw = await extractVaultRaw(status, { password });
      const created = await registerPasskey({
        userId: me?.email ?? "memoca",
        userName: me?.email ?? "memoca",
        displayName: me?.name ?? "Memoca",
      });
      const wrap = await wrapForPasskey(created.prfOutput, raw);
      raw.fill(0);

      await addPasskey({
        credentialId: created.credentialId,
        prfInput: toArrayBuffer(created.prfInput),
        hkdfSalt: wrap.hkdfSalt,
        ct: wrap.ct,
        iv: wrap.iv,
        label: navigator.userAgent.includes("iPhone")
          ? "iPhone"
          : navigator.userAgent.includes("Android")
            ? "Android"
            : "この端末",
      });
      setPassword("");
      toast.success("生体認証を登録しました");
    } catch (cause) {
      setError(
        cause instanceof PrfUnsupportedError
          ? cause.message
          : "登録できませんでした。パスワードが正しいか確認してください。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {status.passkeys.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {status.passkeys.map((key) => (
            <li key={key.credentialId} className="flex items-center gap-3 px-3 py-2">
              <Fingerprint className="text-muted-foreground size-4" aria-hidden />
              <span className="flex-1 text-sm">{key.label}</span>
              <span className="text-muted-foreground text-xs">
                {new Date(key.createdAt).toLocaleDateString("ja-JP")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${key.label} を削除`}
                onClick={async () => {
                  await removePasskey({ credentialId: key.credentialId });
                  toast.success("削除しました");
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {available ? (
        <div className="space-y-2">
          <Label htmlFor="passkey-password">
            登録するには金庫パスワードを入力してください
          </Label>
          <div className="flex gap-2">
            <Input
              id="passkey-password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button onClick={register} disabled={busy || password.length === 0}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              登録
            </Button>
          </div>
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          この端末では生体認証が使えません。パスワードで解除してください。
        </p>
      )}
    </div>
  );
}
