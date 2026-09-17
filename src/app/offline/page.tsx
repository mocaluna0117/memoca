import { CloudOff } from "lucide-react";
import Link from "next/link";
import { t } from "@/lib/i18n/ja";

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <CloudOff className="text-muted-foreground size-8" aria-hidden />
      <h1 className="text-lg font-semibold tracking-tight">{t.sync.offline}</h1>
      <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
        この画面はまだ端末に保存されていません。
        一度開いたことのあるメモは、電波がなくても読み書きできます。
      </p>
      <Link href="/app" className="text-sm underline underline-offset-4">
        メモに戻る
      </Link>
    </main>
  );
}
