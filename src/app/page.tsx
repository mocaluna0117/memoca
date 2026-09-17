import Link from "next/link";
import {
  FolderTree,
  ImageIcon,
  Lock,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n/ja";

const features = [
  {
    icon: FolderTree,
    title: "フォルダで整理",
    body: "何層でもネストできるフォルダに、ドラッグ&ドロップで並べ替え。",
  },
  {
    icon: ImageIcon,
    title: "文章も画像も動画も",
    body: "見出し・リスト・表・コード・数式に加えて、写真や動画も本文に置けます。",
  },
  {
    icon: Zap,
    title: "思いついたらすぐ",
    body: "ホーム画面から一発で書き捨てて、あとから整理。まず書けることを優先しました。",
  },
  {
    icon: Lock,
    title: "端末の中だけで復号",
    body: "ロックしたメモは端末で暗号化してから保存。サーバーでも中身は読めません。",
  },
  {
    icon: Search,
    title: "本文まで検索",
    body: "メモ名やフォルダ名だけでなく本文も対象。ひらがなとカタカナの違いも吸収します。",
  },
  {
    icon: Trash2,
    title: "消しても戻せる",
    body: "削除はいったんゴミ箱へ。保持期間を過ぎたものだけが自動で消えます。",
  },
];

export default function LandingPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-10 sm:px-8">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">{t.app.name}</span>
        <Button asChild variant="ghost" size="sm">
          <Link href="/sign-in">ログイン</Link>
        </Button>
      </header>

      <section className="flex flex-col items-start gap-6 py-16 sm:py-24">
        <h1 className="max-w-2xl text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
          {t.app.tagline}
        </h1>
        <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
          {t.app.description}
          スマートフォンではホーム画面に追加すればアプリのように開けて、電波がなくても読み書きできます。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-in">{t.action.signIn}</Link>
          </Button>
          <span className="text-muted-foreground text-sm">無料・広告なし</span>
        </div>
      </section>

      <section className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {features.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex flex-col gap-2">
            <Icon className="text-muted-foreground size-5" aria-hidden />
            <h2 className="font-medium">{title}</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
          </div>
        ))}
      </section>

      <footer className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-20 text-sm">
        <Link href="/terms" className="hover:text-foreground">
          利用規約
        </Link>
        <Link href="/privacy" className="hover:text-foreground">
          プライバシーポリシー
        </Link>
        <a
          href="https://github.com/mocaluna0117/memoca"
          className="hover:text-foreground"
          target="_blank"
          rel="noreferrer noopener"
        >
          ソースコード
        </a>
      </footer>
    </main>
  );
}
