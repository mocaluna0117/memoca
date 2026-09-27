"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { handoffLink } from "@/lib/auth/handoff";

/**
 * In the browser, signed in: gives the desktop shell a one-time token for a
 * session of its own, through memoca://auth. Made only at the press of the
 * button, so a page that merely opens this one cannot have one made unseen.
 * The token is also shown, for a shell the link does not reach (one run
 * from source, say), to be pasted into it.
 */
export function Handoff({ state }: { state: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const handOver = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const { data, error } = await authClient.oneTimeToken.generate();
      if (error || !data?.token) throw new Error(error?.message ?? "no token");
      setToken(data.token);
      window.location.href = handoffLink(data.token, state);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm space-y-4">
      <h1 className="text-lg font-semibold">デスクトップ版の Memoca に戻ります</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        ボタンを押すと、デスクトップ版の Memoca
        が開いて、ログインが終わります。このブラウザのログインは、そのまま残ります。
      </p>
      <Button onClick={handOver} disabled={busy} size="lg" className="w-full">
        Memoca に戻る
      </Button>
      <p role="status" aria-live="polite" className="text-xs leading-relaxed text-muted-foreground">
        {failed ? (
          "コードを作れませんでした。もう一度お試しください。"
        ) : token ? (
          <>
            開かないときは、このコードをデスクトップ版の「コードを貼り付け」に入れてください（3
            分間有効）。
            <code className="mt-2 block rounded bg-muted px-2 py-1 font-mono text-sm text-foreground select-all">
              {token}
            </code>
          </>
        ) : null}
      </p>
    </div>
  );
}
