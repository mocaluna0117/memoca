"use client";

import { useEffect } from "react";
import { signOut } from "@/lib/auth/client";
import { resetLocalData } from "@/lib/db";

/** Signing out at once, as it runs: asked for once, however often the page's effect runs. */
let signingOut: Promise<void> | null = null;

/**
 * In the desktop shell's window, from its menu: signs the window's own
 * session out (the browser's stays), leaving nothing of the account on the
 * device, as the settings page's ログアウト does, and goes to sign in.
 */
export function SignOut() {
  useEffect(() => {
    signingOut ??= resetLocalData()
      .then(() => signOut())
      .then(
        () => undefined,
        () => undefined,
      );
    void signingOut.then(() => window.location.replace("/sign-in"));
  }, []);
  return <p className="text-sm text-muted-foreground">ログアウトしています…</p>;
}
