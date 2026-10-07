"use client";

import { useEffect, useState } from "react";
import { UnsentText } from "@/components/auth/unsent-warning";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/client";
import { resetLocalData } from "@/lib/db";
import { type Unsent, anyUnsent, unsentOnDevice } from "@/lib/sync/unsent";

/** Signing out at once, as it runs: asked for once, however often the page's effect runs. */
let signingOut: Promise<void> | null = null;

function leave() {
  signingOut ??= resetLocalData()
    .then(() => signOut())
    .then(
      () => undefined,
      () => undefined,
    );
  void signingOut.then(() => window.location.replace("/sign-in"));
}

/**
 * In the desktop shell's window, from its menu: signs the window's own
 * session out (the browser's stays), leaving nothing of the account on the
 * device, as the settings page's ログアウト does, and goes to sign in. Not
 * before asking, if the device has what it alone has (src/lib/sync/unsent.ts).
 */
export function SignOut() {
  const [unsent, setUnsent] = useState<Unsent | null>(null);
  useEffect(() => {
    let current = true;
    void unsentOnDevice()
      .catch(() => ({ changes: 0, files: 0, quickNotes: 0 }))
      .then((kept) => {
        if (!current) return;
        if (anyUnsent(kept)) setUnsent(kept);
        else leave();
      });
    return () => {
      current = false;
    };
  }, []);

  if (!unsent) return <p className="text-sm text-muted-foreground">ログアウトしています…</p>;
  return (
    <div role="alertdialog" aria-labelledby="unsent-title" className="max-w-md space-y-4 text-sm">
      <h1 id="unsent-title" className="font-semibold">
        まだ送っていない内容があります
      </h1>
      <p className="text-muted-foreground">
        <UnsentText unsent={unsent} />
      </p>
      <div className="flex flex-wrap gap-2">
        <Button autoFocus onClick={() => window.location.replace("/app")}>
          ログアウトしない
        </Button>
        <Button variant="destructive" onClick={leave}>
          消えてもよいのでログアウト
        </Button>
      </div>
    </div>
  );
}
