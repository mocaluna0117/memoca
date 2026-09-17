import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/lib/i18n/ja";

export const metadata: Metadata = { title: "利用規約" };

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-5 py-12 leading-relaxed">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← {t.app.name}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">利用規約</h1>

      <section className="space-y-2">
        <h2 className="font-medium">1. このサービスについて</h2>
        <p className="text-muted-foreground text-sm">
          Memoca（以下「本サービス」）は個人が無償で提供するメモアプリです。
          予告なく内容の変更や提供の終了を行うことがあります。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">2. 保証と責任</h2>
        <p className="text-muted-foreground text-sm">
          本サービスは現状有姿で提供され、可用性やデータの保全について保証しません。
          大切なデータは各自でも控えを取ってください。
          本サービスの利用によって生じた損害について、提供者は責任を負いません。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">3. 禁止事項</h2>
        <p className="text-muted-foreground text-sm">
          法令に違反する行為、他者の権利を侵害する内容の保存、
          本サービスの運営を妨げる行為（過度な自動アクセスを含む）を禁止します。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">4. 保存容量と登録</h2>
        <p className="text-muted-foreground text-sm">
          無償で運用しているため、1 人あたりの保存容量と登録人数に上限を設けています。
          上限に達した場合、新規登録は招待制になります。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">5. アカウントの削除</h2>
        <p className="text-muted-foreground text-sm">
          設定画面からいつでも削除できます。削除すると、保存されたデータは復元できません。
        </p>
      </section>
    </main>
  );
}
