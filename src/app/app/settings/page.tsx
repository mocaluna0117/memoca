"use client";

import { useMutation } from "convex/react";
import { Loader2, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useClientValue, useMediaQuery } from "@/lib/hooks/use-client-value";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import { MobileHeader } from "@/components/shell/app-shell";
import { PasskeyManager } from "@/components/vault/passkey-manager";
import { ResetPasswordDialog } from "@/components/vault/password-dialogs";
import { RecoverySettings } from "@/components/vault/recovery-settings";
import { YomiSetting } from "@/components/search/yomi-setting";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { signOut } from "@/lib/auth/client";
import { formatBytes } from "@/lib/bytes";
import { DEFAULT_ARGON } from "@/lib/crypto/primitives";
import { rewrapWithPassword, vault } from "@/lib/crypto/vault";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { useVaultUi } from "@/lib/store/vault-ui";
import { useVaultRecord } from "@/lib/vault/record";
import { resetLocalData } from "@/lib/db";
import { t } from "@/lib/i18n/ja";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { me } = useSync();
  const { theme, setTheme } = useTheme();
  const unlocked = useVaultUnlocked();
  const vaultAvailability = useVaultRecord((s) => s.availability);
  const vaultStatus = useVaultRecord((s) => s.record);
  const updateSettings = useMutation(api.users.updateSettings);
  const rewrap = useMutation(api.vault.rewrap);
  const deleteAccount = useMutation(api.users.deleteAccount);
  const openSetup = useVaultUi((s) => s.openSetup);
  const requestUnlock = useVaultUi((s) => s.requestUnlock);

  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const standalone = useMediaQuery("(display-mode: standalone)");
  const isIOS = useClientValue(() => /iPad|iPhone|iPod/.test(navigator.userAgent), false);

  useEffect(() => {
    // An installed web app should ask the browser to keep its data, which is
    // the difference between a cache that can be evicted and one that persists.
    void navigator.storage?.persist?.().catch(() => false);
  }, []);

  const changePassword = async () => {
    if (!vaultStatus) return;
    setChanging(true);
    try {
      const next = await rewrapWithPassword(
        vaultStatus,
        currentPassword,
        nextPassword,
        DEFAULT_ARGON,
      );
      await rewrap({ argon: next.argon, saltPw: next.saltPw, pwWrap: next.pwWrap });
      setCurrentPassword("");
      setNextPassword("");
      toast.success("パスワードを変更しました");
    } catch {
      toast.error("現在のパスワードが正しくありません。");
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-1 flex-col">
      <MobileHeader title={t.nav.settings} />
      <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-6 sm:px-6">
        <h1 className="text-lg font-semibold tracking-tight">{t.nav.settings}</h1>

        <Section title="外観">
          <Select value={theme ?? "system"} onValueChange={setTheme}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">端末の設定に合わせる</SelectItem>
              <SelectItem value="light">ライト</SelectItem>
              <SelectItem value="dark">ダーク</SelectItem>
            </SelectContent>
          </Select>
        </Section>

        <Separator />

        <Section
          title="ゴミ箱"
          description="削除したメモを残しておく期間です。過ぎたものは自動で完全に削除されます。"
        >
          <Select
            value={String(me?.settings.trashRetentionDays ?? 30)}
            onValueChange={(value) =>
              void updateSettings({ trashRetentionDays: Number(value) })
            }
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 日</SelectItem>
              <SelectItem value="30">30 日</SelectItem>
              <SelectItem value="90">90 日</SelectItem>
            </SelectContent>
          </Select>
        </Section>

        <Separator />

        <Section
          title="読みで検索"
          description="漢字のメモを、読み方（ひらがな・カタカナ）でも探せるようにします。「薬局」を「やっきょく」で見つけられます。"
        >
          <YomiSetting />
        </Section>

        <Separator />

        <Section
          title={t.vault.title}
          description="ロックしたメモは、この端末の中だけで暗号化・復号されます。サーバーには暗号文しか保存されません。"
        >
          {vaultAvailability === "unknown" ? (
            // Not known yet, or offline. Offering to create a vault here would
            // let an account that already has one start a second.
            <p className="text-muted-foreground text-sm">金庫の情報を読み込んでいます…</p>
          ) : vaultAvailability === "none" || !vaultStatus ? (
            <Button onClick={openSetup} className="gap-2">
              <ShieldCheck className="size-4" aria-hidden />
              {t.vault.setupTitle}
            </Button>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                <span className="text-sm">
                  状態：{unlocked ? "解除中" : t.vault.locked}
                </span>
                {unlocked ? (
                  <Button variant="outline" size="sm" onClick={() => void vault.close()}>
                    {t.vault.lockNow}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void requestUnlock()}>
                    {t.vault.unlock}
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                <Label>自動ロック</Label>
                <Select
                  value={String(me?.settings.autoLockMinutes ?? 5)}
                  onValueChange={(value) => {
                    void updateSettings({ autoLockMinutes: Number(value) });
                    vault.setAutoLockMinutes(Number(value));
                  }}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 分</SelectItem>
                    <SelectItem value="5">5 分</SelectItem>
                    <SelectItem value="15">15 分</SelectItem>
                    <SelectItem value="60">60 分</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>生体認証（Face ID / Touch ID）</Label>
                <PasskeyManager />
              </div>

              <div className="space-y-2">
                <Label>リカバリーキー</Label>
                <RecoverySettings />
              </div>

              <div className="space-y-2">
                <Label>パスワードの変更</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="password"
                    placeholder="現在のパスワード"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                  <Input
                    type="password"
                    placeholder="新しいパスワード"
                    autoComplete="new-password"
                    value={nextPassword}
                    onChange={(event) => setNextPassword(event.target.value)}
                  />
                  <Button
                    onClick={changePassword}
                    disabled={changing || nextPassword.length < 8}
                  >
                    {changing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    変更
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  メモの中身を暗号化し直す必要はありません。鍵の包み方だけが変わります。
                </p>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
                  onClick={() => setResetting(true)}
                >
                  パスワードを忘れた場合
                </button>
                <ResetPasswordDialog
                  open={resetting}
                  onOpenChange={setResetting}
                  record={vaultStatus}
                />
              </div>
            </div>
          )}
        </Section>

        <Separator />

        <Section title="ホーム画面に追加">
          {standalone ? (
            <p className="text-muted-foreground text-sm">
              アプリとして開いています。オフラインでも読み書きできます。
            </p>
          ) : isIOS ? (
            <p className="text-muted-foreground text-sm leading-relaxed">
              <Smartphone className="mr-1 inline size-4 align-text-bottom" aria-hidden />
              Safari の共有ボタンから「ホーム画面に追加」を選ぶと、アプリのように開けます。
              追加したあとは一度だけログインし直してください（Safari とはデータが分かれているためです）。
              他のアプリから送りたいときは、ショートカットアプリで
              <span className="font-mono text-xs"> /quick?text= </span>
              を開く動作を作ると共有シートから使えます。
            </p>
          ) : (
            <p className="text-muted-foreground text-sm leading-relaxed">
              ブラウザのメニューから「アプリをインストール」を選ぶと、ホーム画面から開けます。
              共有メニューから Memoca に直接送れるようにもなります。
            </p>
          )}
        </Section>

        <Separator />

        <Section title="保存容量">
          <p className="text-sm">
            {t.quota.used(
              formatBytes((me?.usedBytes ?? 0) + (me?.reservedBytes ?? 0)),
              formatBytes(me?.quotaBytes ?? 0),
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            画像は自動で縮小して保存されます。動画は 1 本あたり{" "}
            {formatBytes(me?.limits.maxVideoBytes ?? 0)} までです。
          </p>
        </Section>

        <Separator />

        <Section title="アカウント" description={me?.email}>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-2"
              onClick={async () => {
                await resetLocalData();
                await signOut();
                router.push("/");
              }}
            >
              <LogOut className="size-4" aria-hidden />
              {t.action.signOut}
            </Button>
            <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              アカウントを削除
            </Button>
          </div>
        </Section>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>アカウントを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              すべてのメモ・フォルダ・画像・動画が完全に削除されます。取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.action.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                await deleteAccount();
                await resetLocalData();
                await signOut();
                router.push("/");
              }}
            >
              {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
