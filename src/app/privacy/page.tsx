import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/lib/i18n/ja";

export const metadata: Metadata = { title: "プライバシーポリシー" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-5 py-12 leading-relaxed">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← {t.app.name}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">プライバシーポリシー</h1>

      <section className="space-y-2">
        <h2 className="font-medium">取得する情報</h2>
        <p className="text-muted-foreground text-sm">
          Google ログインから受け取るメールアドレス・表示名・プロフィール画像、
          および利用者が作成したメモ、フォルダ、画像や動画を保存します。
          広告目的の収集や第三者への提供は行いません。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">ロックしたメモの扱い</h2>
        <p className="text-muted-foreground text-sm">
          ロックしたメモの本文・タイトル・添付ファイルは、端末の中で AES-256-GCM
          により暗号化してから送信されます。復号に必要な鍵はサーバーに送られないため、
          提供者を含め誰も内容を読むことができません。
          一方で、メモの件数・データの大きさ・更新日時・フォルダ名は暗号化されず、
          運用のためにサーバー側で見える状態にあります。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">パスワードを忘れた場合</h2>
        <p className="text-muted-foreground text-sm">
          ロック用のパスワード、リカバリーキー、登録した生体認証をすべて失うと、
          ロックしたメモは復元できません。提供者による復旧もできません。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">保存場所</h2>
        <p className="text-muted-foreground text-sm">
          データは Convex（データベースとファイル保存）と Vercel（アプリの配信）上に保存されます。
          端末内には IndexedDB を用いて複製が保存され、オフラインでの利用に使われます。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">削除</h2>
        <p className="text-muted-foreground text-sm">
          設定画面からアカウントを削除すると、サーバー上のデータは完全に削除されます。
          端末内の複製もログアウト時に消去されます。
        </p>
      </section>
    </main>
  );
}
