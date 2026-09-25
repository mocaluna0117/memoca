"use client";

import { useMutation } from "convex/react";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import { LockHealth } from "@/components/vault/lock-health";
import { PasskeyManager } from "@/components/vault/passkey-manager";
import { ChangePasswordDialog, ResetPasswordDialog } from "@/components/vault/password-dialogs";
import { RecoverySettings } from "@/components/vault/recovery-settings";
import { closeVaultNow } from "@/components/vault/vault-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { vault } from "@/lib/crypto/vault";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { useOnline } from "@/lib/hooks/use-online";
import { t } from "@/lib/i18n/ja";
import { requestVault } from "@/lib/store/vault-gate";
import { type StoredVaultRecord, useVaultRecord } from "@/lib/vault/record";

function Part({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-medium">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * Everything about the vault in one place, in the order it is usually
 * needed: whether it is open, when it closes by itself, the ways to open it,
 * the recovery key, the password, and any notes that cannot be opened.
 */
export function VaultSettings() {
  const { me } = useSync();
  const unlocked = useVaultUnlocked();
  const availability = useVaultRecord((s) => s.availability);
  const record = useVaultRecord((s) => s.record);
  const updateSettings = useMutation(api.users.updateSettings);
  const online = useOnline();

  if (availability === "unknown") {
    // Not known yet, or offline. Offering to create a vault here would let an
    // account that already has one start a second.
    return (
      <p className="text-muted-foreground text-sm">
        {online ? "金庫の情報を読み込んでいます…" : "オフラインのため、金庫の情報を確認できません。"}
      </p>
    );
  }
  if (availability === "none" || !record) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          まだ金庫はありません。メモやフォルダを初めてロックするときに作成します。
        </p>
        <Button onClick={() => void requestVault({ kind: "setup" })} className="gap-2">
          <ShieldCheck className="size-4" aria-hidden />
          {t.vault.setupTitle}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">{unlocked ? t.vault.isOpen : t.vault.isClosed}</span>
        {unlocked ? (
          <Button variant="outline" size="sm" onClick={() => void closeVaultNow()}>
            {t.vault.closeNow}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={(event) =>
              void requestVault(
                { kind: "open", from: "general" },
                { gesture: true, returnFocus: event.currentTarget },
              )
            }
          >
            {t.vault.open}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-auto-close">自動で閉じるまでの時間</Label>
        <Select
          value={String(me?.settings.autoLockMinutes ?? 5)}
          onValueChange={(value) => {
            void updateSettings({ autoLockMinutes: Number(value) });
            vault.setAutoLockMinutes(Number(value));
          }}
        >
          <SelectTrigger id="settings-auto-close" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1 分</SelectItem>
            <SelectItem value="5">5 分</SelectItem>
            <SelectItem value="15">15 分</SelectItem>
            <SelectItem value="60">60 分</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          金庫を開いたあと、この時間なにも操作しないと自動で閉じます。アプリを閉じたときや再読み込みしたときも閉じます。
        </p>
      </div>

      <Part id="settings-passkeys" title="パスキー（Face ID・Touch ID など）">
        <PasskeyManager />
      </Part>

      <Part id="settings-recovery" title={t.vault.recoveryKey}>
        <RecoverySettings />
      </Part>

      <Part id="settings-password" title={t.vault.password}>
        <PasswordSettings record={record} />
      </Part>

      <LockHealth />
    </div>
  );
}

/** The password: changing it, and setting a new one when it is forgotten. */
function PasswordSettings({ record }: { record: StoredVaultRecord }) {
  const [changing, setChanging] = useState(false);
  const [resetting, setResetting] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
        パスワードを変更
      </Button>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
        onClick={() => setResetting(true)}
      >
        パスワードを忘れた場合
      </button>
      <ChangePasswordDialog open={changing} onOpenChange={setChanging} record={record} />
      <ResetPasswordDialog open={resetting} onOpenChange={setResetting} record={record} />
    </div>
  );
}
