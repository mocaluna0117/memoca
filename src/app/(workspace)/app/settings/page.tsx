"use client";

import { useMutation } from "convex/react";
import { Loader2, LogOut, Smartphone } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useClientValue, useMediaQuery } from "@/lib/hooks/use-client-value";
import { SIDEBAR_MODES, type SidebarMode, useSidebarMode } from "@/lib/hooks/use-sidebar-mode";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import { MobileHeader } from "@/components/shell/app-shell";
import { VaultSettings } from "@/components/vault/vault-settings";
import { ImageDiagnostics } from "@/components/settings/image-diagnostics";
import { ConvertImages } from "@/components/settings/convert-images";
import { ExportAll } from "@/components/settings/export-all";
import { SignOutElsewhere } from "@/components/settings/sign-out-elsewhere";
import { StorageBreakdown } from "@/components/settings/storage-breakdown";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { signOut } from "@/lib/auth/client";
import { UnsentDialog } from "@/components/auth/unsent-warning";
import { type Unsent, anyUnsent, unsentOnDevice } from "@/lib/sync/unsent";
import { formatBytes } from "@/lib/bytes";
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
  const updateSettings = useMutation(api.users.updateSettings);
  const [sidebarMode, setSidebarMode] = useSidebarMode();
  const deleteAccount = useMutation(api.users.deleteAccount);

  const [confirmDelete, setConfirmDelete] = useState(false);
  // What only this device has, asked about before signing out loses it.
  const [unsent, setUnsent] = useState<Unsent | null>(null);
  const leave = async () => {
    await resetLocalData();
    // With no network the server is not told, but nothing of the account is
    // left here, and it goes on as the desktop shell's sign-out does.
    await signOut().catch(() => undefined);
    router.push("/");
  };
  const [deleting, setDeleting] = useState(false);
  const standalone = useMediaQuery("(display-mode: standalone)");
  const isIOS = useClientValue(() => /iPad|iPhone|iPod/.test(navigator.userAgent), false);

  useEffect(() => {
    // An installed web app should ask the browser to keep its data, which is
    // the difference between a cache that can be evicted and one that persists.
    void navigator.storage?.persist?.().catch(() => false);
  }, []);

  return (
    <div className="flex flex-1 flex-col">
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
          title="フォルダのメモ"
          description="「フォルダの中に表示」では、VS Code のエクスプローラーのように、フォルダを開くとその中にメモが並びます。「横の一覧に表示」では、フォルダを選ぶと、サイドバーの横にメモの一覧が出ます。この端末だけの設定です。"
        >
          <Select
            value={sidebarMode}
            onValueChange={(value) => setSidebarMode(value as SidebarMode)}
          >
            <SelectTrigger className="w-48" aria-label="フォルダのメモ">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIDEBAR_MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
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
          title={t.vault.title}
          description="ロックしたメモの本文・タイトル・添付ファイルは、金庫の鍵で暗号化され、あなたの端末の中でだけ読めます。フォルダ名、メモの件数、更新日時は暗号化されません。"
        >
          <VaultSettings />
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
          {me ? (
            <StorageBreakdown
              account={me.userKey}
              live={{ quotaBytes: me.quotaBytes, usedBytes: me.usedBytes, reservedBytes: me.reservedBytes }}
              admin={me.role === "admin"}
            />
          ) : null}
          {me ? <ConvertImages allowance={me} /> : null}
          {me?.role === "admin" ? <ImageDiagnostics maxImageBytes={me.limits.maxImageBytes} /> : null}
        </Section>

        <Separator />

        <Section
          title="書き出し"
          description="ゴミ箱以外のすべてのメモを、フォルダの形のまま Markdown（.md）にして、画像などのファイルと一緒に 1 つの ZIP で保存します。ほかのアプリへの移行や、手元での保管に使えます。"
        >
          <ExportAll />
        </Section>

        <Separator />

        <Section title="アカウント" description={me?.email}>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-2"
              onClick={async () => {
                const kept = await unsentOnDevice();
                if (anyUnsent(kept)) setUnsent(kept);
                else await leave();
              }}
            >
              <LogOut className="size-4" aria-hidden />
              {t.action.signOut}
            </Button>
            <UnsentDialog
              unsent={unsent}
              onCancel={() => setUnsent(null)}
              onConfirm={() => {
                setUnsent(null);
                void leave();
              }}
            />
            <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              アカウントを削除
            </Button>
          </div>
          <SignOutElsewhere />
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
