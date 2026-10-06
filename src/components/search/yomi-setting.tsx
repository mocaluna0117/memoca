"use client";

import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useYomi } from "@/lib/hooks/use-yomi";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Reading search is opt-in because turning it on downloads an 11 MB Japanese
 * dictionary. Spending someone's mobile data without asking is not something
 * a notes app should do quietly, so the size is stated before the tap.
 */
export function YomiSetting() {
  const { enabled, state, progress, busy, enable, disable, kept, setKept } = useYomi();

  if (enabled === undefined) return null;

  if (!enabled) {
    return (
      <div className="space-y-2">
        <Button onClick={() => void enable()} disabled={busy} className="gap-2">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          有効にする（辞書 11MB をダウンロード）
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
            辞書は読みを調べ終わると削除し、端末に残しません（残すこともできます）。
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
      <div className="space-y-1 pt-1">
        <p className="text-sm">辞書（11MB）</p>
        <Select
          value={kept ? "keep" : "use"}
          onValueChange={(value) => void setKept(value === "keep")}
        >
          <SelectTrigger className="w-72" aria-label="読みの辞書">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="use">使うときだけダウンロード（端末に残さない）</SelectItem>
            <SelectItem value="keep">端末に残す（オフラインでも使える）</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {kept
            ? "辞書を端末に保存し、新しく書いたメモの読みは、かなで検索したときに調べます。"
            : "辞書は端末に保存しません。新しく書いたメモの読みは、検索画面で辞書をオンにしたときにダウンロードして調べ、1 分使わないと削除します。調べ終わった読みは残るので、辞書がなくても読みで見つかります。"}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void disable()} disabled={busy}>
        無効にして辞書を削除
      </Button>
      <p className="text-muted-foreground text-xs leading-relaxed">
        無効にすると、端末の辞書と調べ終わった読みを削除します。
      </p>
    </div>
  );
}
