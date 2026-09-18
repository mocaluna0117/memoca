"use client";

import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useYomi } from "@/lib/hooks/use-yomi";

/**
 * Reading search is opt-in because turning it on downloads a 17 MB Japanese
 * dictionary. Spending someone's mobile data without asking is not something
 * a notes app should do quietly, so the size is stated before the tap.
 */
export function YomiSetting() {
  const { enabled, state, progress, busy, enable, disable } = useYomi();

  if (enabled === undefined) return null;

  if (!enabled) {
    return (
      <div className="space-y-2">
        <Button onClick={() => void enable()} disabled={busy} className="gap-2">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          有効にする（辞書 17MB をダウンロード）
        </Button>
        {busy ? (
          <div className="space-y-1">
            <Progress
              value={
                progress && progress.total > 0
                  ? (progress.done / progress.total) * 100
                  : undefined
              }
              className="h-1"
            />
            <p className="text-muted-foreground text-xs">
              {progress && progress.total > 0
                ? `既存のメモを読み込み中… ${progress.done} / ${progress.total} 件`
                : "辞書をダウンロード中…"}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs leading-relaxed">
            一度ダウンロードすれば端末に保存され、次からは電波がなくても使えます。
            読みの計算は端末の中だけで行われ、メモの内容は送信されません。
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-sm">
        <Check className="size-4 text-emerald-600" aria-hidden />
        有効です
        {state === "loading" ? (
          <span className="text-muted-foreground text-xs">（辞書を読み込み中）</span>
        ) : null}
        {state === "unavailable" ? (
          <span className="text-destructive text-xs">（辞書を読み込めませんでした）</span>
        ) : null}
      </p>
      <Button variant="outline" size="sm" onClick={() => void disable()} disabled={busy}>
        無効にする
      </Button>
      <p className="text-muted-foreground text-xs">
        無効にすると、計算済みの読みは端末から削除されます。
      </p>
    </div>
  );
}
