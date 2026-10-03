"use client";

import { Fingerprint, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/vault/password-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { VaultRecord } from "@/lib/crypto/vault";
import {
  DeviceUnlockCancelled,
  deviceUnlockLabel,
  enrollDeviceUnlockWithPassword,
  forgetDeviceUnlock,
  useDeviceUnlock,
} from "@/lib/vault/device-unlock";

/**
 * Opening the vault with the computer's own check (Touch ID, Windows Hello)
 * in the desktop app: turned on with the password, or off. Nothing shown
 * anywhere else, where it cannot be had.
 */
export function DeviceUnlockSettings({ record }: { record: VaultRecord }) {
  const device = useDeviceUnlock();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!device.kind) return null;
  const label = deviceUnlockLabel(device.kind);

  if (device.enrolled) {
    return (
      <div className="space-y-2">
        <p className="text-sm">{`このアプリでは、${label} で金庫を開けます。`}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void forgetDeviceUnlock().then(() => toast.success(`${label} を使わないようにしました`))
          }
        >
          使わない
        </Button>
      </div>
    );
  }

  const turnOn = async () => {
    if (busy) return;
    if (password.length === 0) {
      setError("金庫のパスワードを入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await enrollDeviceUnlockWithPassword(record, password);
      setPassword("");
      toast.success(`次からは ${label} で金庫を開けます`);
    } catch (cause) {
      if (cause instanceof DeviceUnlockCancelled) return;
      setError(
        (cause as { name?: string } | null)?.name === "OperationError"
          ? "パスワードが違います。"
          : `${label} を使えるようにできませんでした。`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void turnOn();
      }}
    >
      <p className="text-xs text-muted-foreground">
        {`パスワードの代わりに ${label} で金庫を開けるようにします。開くための鍵は、このパソコンだけに保存されます。`}
      </p>
      <Label htmlFor="settings-device-unlock">金庫のパスワード</Label>
      <PasswordInput
        id="settings-device-unlock"
        value={password}
        autoComplete="current-password"
        onChange={(event) => setPassword(event.target.value)}
        aria-invalid={error ? true : undefined}
        className="max-w-xs"
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={busy} className="gap-2">
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Fingerprint className="size-4" aria-hidden />
        )}
        {`${label} を使う`}
      </Button>
    </form>
  );
}
