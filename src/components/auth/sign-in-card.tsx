"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { signInWithGoogle } from "@/lib/auth/client";
import { t } from "@/lib/i18n/ja";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function SignInCard() {
  const router = useRouter();
  const status = useQuery(api.users.signupStatus);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      await signInWithGoogle("/app");
    } catch {
      setBusy(false);
      router.refresh();
    }
  };

  return (
    <div className="w-full max-w-sm space-y-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.app.name}</h1>
        <p className="text-muted-foreground text-sm">{t.app.tagline}</p>
      </div>

      <Button onClick={start} disabled={busy} size="lg" className="w-full gap-2">
        <GoogleMark />
        {busy ? "ログイン中…" : t.action.signIn}
      </Button>

      {status && !status.open ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          いまは新規登録を受け付けていません（{status.userCount} / {status.maxUsers} 人）。
          招待コードをお持ちの場合は、ログイン後に入力できます。
        </p>
      ) : null}
    </div>
  );
}
