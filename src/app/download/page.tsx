import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n/ja";

export const metadata: Metadata = { title: "デスクトップ版" };

/** Where the desktop app is released (.github/workflows/desktop.yml): public, each version a release. */
const RELEASES = "https://github.com/mocaluna0117/memoca/releases";

/**
 * The version out now, as the apps themselves learn it: the updater's
 * latest.json, at the same address whatever the version. Read again every
 * ten minutes at most. Null if it cannot be read: the list of releases then.
 */
async function latestVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${RELEASES}/latest/download/latest.json`, { next: { revalidate: 600 } });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version?: unknown };
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** A file of a version, by the names the release workflow gives them. */
const fileOf = (version: string, name: string) => `${RELEASES}/download/desktop-v${version}/${name}`;

/**
 * The desktop app, to download: for anyone, signed in or not (from the
 * landing page, and from the settings). With what it takes to open it the
 * first time, as it is not signed by Apple or Microsoft (docs/DESKTOP.md).
 */
export default async function DownloadPage() {
  const version = await latestVersion();
  const mac = version ? fileOf(version, `Memoca_${version}_universal.dmg`) : `${RELEASES}/latest`;
  const windows = version ? fileOf(version, `Memoca_${version}_x64-setup.exe`) : `${RELEASES}/latest`;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 px-5 py-12 leading-relaxed">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← {t.app.name}
      </Link>

      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          デスクトップ版<span className="whitespace-nowrap">（Mac・Windows）</span>
        </h1>
        <p className="text-muted-foreground text-sm">
          メニューバー（Windows ではタスクバーの通知領域）に常駐して、ホットキー（Mac は ⌘⇧M、Windows は
          Ctrl＋Shift＋M）で、いつでも即席メモを小さな窓で出せるアプリです。メモの一覧や編集をする Memoca
          全体のウィンドウも開けます。新しい版は自動で入ります。
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button asChild size="lg" className="gap-2">
            <a href={mac}>
              <Download className="size-4" aria-hidden />
              Mac 版をダウンロード
            </a>
          </Button>
          <Button asChild size="lg" variant="outline" className="gap-2">
            <a href={windows}>
              <Download className="size-4" aria-hidden />
              Windows 版をダウンロード
            </a>
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {version ? `最新版 ${version}・` : ""}Mac 版は Apple シリコンと Intel のどちらでも動きます。Windows 版は
          Windows 10・11 用です。
          <a href={RELEASES} className="ml-1 underline underline-offset-2" target="_blank" rel="noreferrer noopener">
            これまでの版
          </a>
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">初めて開くとき（Mac）</h2>
        <p className="text-muted-foreground text-sm">
          アプリには Apple の署名がないため、初めて開くときだけ、macOS に「開いてよい」と伝える手順が要ります。
        </p>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
          <li>ダウンロードした「.dmg」を開き、Memoca を「アプリケーション」フォルダにドラッグします。</li>
          <li>
            「アプリケーション」の Memoca を開きます。「開いていません」や「開発元を確認できません」と出たら、{""}
            「完了」（または「キャンセル」）を押します。
          </li>
          <li>
            「システム設定」→「プライバシーとセキュリティ」の下のほうにある「“Memoca”は Mac
            を保護するためにブロックされました」の「このまま開く」を押します。Mac のパスワード（または Touch
            ID）を求められたら入れます。
          </li>
          <li>もう一度 Memoca を開き、「このまま開く」を押します。次からは、そのまま開きます。</li>
        </ol>
        <p className="text-muted-foreground text-xs">
          macOS 14 までは、Finder で Memoca を右クリックして「開く」を選んでも開けます。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">初めて開くとき（Windows）</h2>
        <p className="text-muted-foreground text-sm">
          アプリには Microsoft の署名がないため、初めて入れるときだけ、Windows の確認を通る手順が要ります。
        </p>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
          <li>ダウンロードした「.exe」を開きます。</li>
          <li>「Windows によって PC が保護されました」と出たら、「詳細情報」を押し、「実行」を押します。</li>
          <li>
            案内に沿って進めます（管理者の権限は要りません）。終わるとアプリが起動し、タスクバーの右の通知領域に常駐します。
          </li>
        </ol>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">ログイン</h2>
        <p className="text-muted-foreground text-sm">
          初めて開くと、窓に「ブラウザでログイン」が出ます。押すと、いつものブラウザでログインして、アプリに戻ります。{""}
          使い方の詳しい説明は
          <a
            href="https://github.com/mocaluna0117/memoca/blob/main/docs/DESKTOP.md"
            className="mx-1 underline underline-offset-2"
            target="_blank"
            rel="noreferrer noopener"
          >
            デスクトップ版の説明
          </a>
          にあります。
        </p>
      </section>

      <p className="text-muted-foreground text-xs">
        ダウンロードは GitHub（Memoca のソースコードを置いている場所）から始まります。
      </p>
    </main>
  );
}
