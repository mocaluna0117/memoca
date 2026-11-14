"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { isStaleChunk } from "@/lib/ui/stale-chunk";

/**
 * Shown in place of a page that broke while drawing, in Japanese and with a
 * way back, instead of Next's own English page with none.
 *
 * A part of the app that failed to load (a new version went out meanwhile)
 * is not fetched again by trying in place: then the page is loaded again.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const stale = isStaleChunk(error);
  return (
    <main
      role="alert"
      className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <TriangleAlert className="text-muted-foreground size-8" aria-hidden />
      <h1 className="text-lg font-semibold tracking-tight">画面を表示できませんでした</h1>
      <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
        {stale
          ? "新しい版が出たか、通信が切れたため、画面の一部を読み込めませんでした。読み込み直すと続けられます。"
          : "思わぬ問題が起きました。もう一度試すか、読み込み直してください。"}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {stale ? null : (
          <Button variant="outline" size="sm" onClick={() => retry()}>
            もう一度試す
          </Button>
        )}
        <Button
          variant={stale ? "default" : "ghost"}
          size="sm"
          className="gap-1.5"
          onClick={() => window.location.reload()}
        >
          <RotateCw className="size-3.5" aria-hidden />
          読み込み直す
        </Button>
      </div>
    </main>
  );
}
