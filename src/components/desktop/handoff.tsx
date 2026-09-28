"use client";

import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { authClient, signInWithGoogle } from "@/lib/auth/client";
import { FRESH_MS, desktopHandoff, handoffLink } from "@/lib/auth/handoff";
import { forCallback } from "@/lib/auth/next";
import { cn } from "@/lib/utils";

/**
 * In the browser, signed in: has the server make a code for the desktop
 * shell that asked (for its challenge), and offers the link that takes it
 * there. It says which account the shell is signed in to, and what that
 * lets it do, and shows the few letters the shell shows, so a page sent by
 * someone else, for a shell of theirs, is not gone along with.
 *
 * Made only at the press of the button, so a page that merely opens this
 * one cannot have one made unseen; and only for a browser signed in the
 * last few minutes, so Google is asked again first for one signed in long
 * ago. The code is made before the link is followed (a browser that does
 * not know memoca://, Firefox say, puts an error page in this one's place),
 * and shown only when asked for, for a shell the link does not reach, with
 * what not to do with it. Where the deployment has not turned the handover
 * on, it says so.
 */
export function Handoff({
  state,
  challenge,
  check,
}: {
  state: string;
  challenge: string;
  check: string;
}) {
  const { data: session } = authClient.useSession();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [shown, setShown] = useState(false);

  /** Google, asked again, comes back here to go on. */
  const signInAgain = () => signInWithGoogle(forCallback(desktopHandoff({ state, challenge })));

  const make = async () => {
    setBusy(true);
    setFailed(false);
    try {
      // Known here to be too long ago: straight to Google. Not known yet
      // (the page just shown): the server says.
      if (session && !(Date.now() - new Date(session.session.createdAt).getTime() < FRESH_MS)) {
        await signInAgain();
        return;
      }
      const { data, error } = await authClient.$fetch<{ code: string }>("/desktop/code", {
        method: "POST",
        body: { challenge },
      });
      if (error?.status === 404) {
        setUnavailable(true);
        return;
      }
      // Signed in longer ago than it looked from here.
      if (error?.status === 403) {
        await signInAgain();
        return;
      }
      if (error || !data?.code) throw new Error(error?.message ?? "no code");
      setCode(data.code);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) {
    return (
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-lg font-semibold">デスクトップ版の Memoca にログインします</h1>
        <p role="status" className="text-sm leading-relaxed text-muted-foreground">
          デスクトップ版へのログインは、まだ使えません。
        </p>
      </div>
    );
  }

  if (code) {
    return (
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-lg font-semibold">デスクトップ版の Memoca に戻ります</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          開くと、デスクトップ版のログインが終わります。3 分以内に開いてください。
        </p>
        <a href={handoffLink(code, state)} className={cn(buttonVariants({ size: "lg" }), "w-full")}>
          デスクトップ版の Memoca を開く
        </a>
        <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
          {shown ? (
            <>
              <p>
                デスクトップ版の「コードを貼り付け」の欄にだけ入れてください。ほかの場所に入れたり、人に教えたりしないでください（Memoca
                を名乗る相手にも）。
              </p>
              <code className="block rounded bg-muted px-2 py-1 font-mono text-sm break-all text-foreground select-all">
                {code}
              </code>
            </>
          ) : (
            <Button variant="link" size="sm" onClick={() => setShown(true)}>
              開かないときは、コードを表示
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm space-y-4">
      <h1 className="text-lg font-semibold">デスクトップ版の Memoca にログインします</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {session ? `${session.user.email} のアカウント` : "このアカウント"}
        で、デスクトップ版にログインします。デスクトップ版で、このアカウントのメモを読み書きできるようになります。
      </p>
      <div className="space-y-1 rounded-lg border px-3 py-2">
        <p className="text-xs text-muted-foreground">デスクトップ版の窓に出ている文字と同じですか</p>
        <p
          className="font-mono text-lg font-semibold tracking-widest"
          aria-label={`確認用の文字 ${check}`}
        >
          {check}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        デスクトップ版で「ブラウザでログイン」を押していないとき、または文字が違うときは、続けずにこのページを閉じてください。
      </p>
      <Button onClick={make} disabled={busy} size="lg" className="w-full">
        デスクトップ版にログインする
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        しばらく前にログインしたブラウザでは、確認のため、Google のログインをもう一度通ります。
      </p>
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          ログインを続けられませんでした。もう一度お試しください。
        </p>
      ) : null}
    </div>
  );
}
