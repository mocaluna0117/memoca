"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";

/**
 * Ends every other sign-in of the account: the desktop app's (a session of
 * its own, docs/DESKTOP.md), other browsers', other phones'. This one stays.
 */
export function SignOutElsewhere() {
  const [said, setSaid] = useState<"done" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);

  const signOutElsewhere = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const { error } = await authClient.revokeOtherSessions();
      setSaid(error ? "failed" : "done");
    } catch {
      setSaid("failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button variant="outline" onClick={signOutElsewhere} disabled={busy}>
        ほかの端末をすべてログアウト
      </Button>
      <p role="status" aria-live="polite" className="text-xs leading-relaxed text-muted-foreground">
        {said === "done"
          ? "ほかの端末をログアウトしました。"
          : said === "failed"
            ? "ログアウトできませんでした。通信を確かめて、もう一度お試しください。"
            : "デスクトップ版や、ほかのブラウザ・スマホのログインを終わらせます。この端末はログインしたままです。"}
      </p>
    </div>
  );
}
