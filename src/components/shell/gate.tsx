"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signOut } from "@/lib/auth/client";
import { t } from "@/lib/i18n/ja";

/**
 * Stands between sign-in and the app while the account row is created, and
 * explains the invite-code path when the free tier is full.
 */
export function AccountGate({ children }: { children: ReactNode }) {
  const { gate, submitInvite } = useSync();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  if (gate === "ready") return <>{children}</>;

  if (gate === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" aria-hidden />
        <span className="sr-only">読み込み中</span>
      </div>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          いまは新規登録を受け付けていません
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          無料枠の上限に達したため、登録は招待コードをお持ちの方だけになっています。
          {gate === "badInvite" ? (
            <span className="text-destructive mt-2 block">
              コードが正しくないか、有効期限が切れています。
            </span>
          ) : null}
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          await submitInvite(code.trim().toUpperCase());
          setBusy(false);
        }}
      >
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="招待コード"
          autoCapitalize="characters"
          className="uppercase"
        />
        <Button type="submit" disabled={busy || code.trim().length === 0}>
          送信
        </Button>
      </form>

      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          await signOut();
          router.push("/");
        }}
      >
        {t.action.signOut}
      </Button>
    </main>
  );
}
