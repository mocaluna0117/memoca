"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isHandoffCode, pastedCode } from "@/lib/auth/handoff";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { t } from "@/lib/i18n/ja";

/**
 * Signing in inside the desktop shell, where Google will not have it: in the
 * default browser instead, which comes back to the shell when it is done;
 * or, where the way back does not reach the shell, with the code the
 * browser shows, which the shell takes only for the sign-in it started.
 * The few letters the browser shows for that sign-in are shown here too.
 * Kept small: the window is 420×360.
 */
export function ShellSignInCard() {
  const canBegin = useClientValue(
    () => typeof window.memocaShell?.beginSignIn === "function",
    false,
  );
  const [text, setText] = useState("");
  const [notStarted, setNotStarted] = useState(false);
  /** The few letters the browser shows for the sign-in started (src/lib/auth/handoff.ts). */
  const [check, setCheck] = useState<string | null>(null);
  const code = pastedCode(text);

  return (
    <div className="w-full max-w-sm space-y-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{t.app.name}</h1>

      <div className="space-y-2">
        <Button
          onClick={async () => {
            setNotStarted(false);
            setCheck((await window.memocaShell?.beginSignIn?.()) ?? null);
          }}
          disabled={!canBegin}
          size="lg"
          className="w-full"
        >
          ブラウザでログイン
        </Button>
        {check ? (
          <p role="status" className="text-xs leading-relaxed text-muted-foreground">
            ブラウザに
            <span className="mx-1 font-mono text-sm font-semibold tracking-widest text-foreground">
              {check}
            </span>
            と出ていれば、そのまま進めてください。
          </p>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            いつものブラウザで Google にログインします。終わると、ここに戻ります。
          </p>
        )}
      </div>

      <form
        className="space-y-2 text-left"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!isHandoffCode(code)) return;
          const answer = await window.memocaShell?.completeSignIn?.(code);
          setNotStarted(answer !== "ok");
        }}
      >
        <label htmlFor="handoff-code" className="text-xs font-medium">
          コードを貼り付け（ブラウザに表示されたもの）
        </label>
        <div className="flex gap-2">
          <Input
            id="handoff-code"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <Button type="submit" variant="outline" disabled={!isHandoffCode(code)}>
            ログイン
          </Button>
        </div>
        {notStarted ? (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            先に「ブラウザでログイン」を押して、開いたブラウザでログインしてください。コードは、そのとき表示されたものだけが使えます（押してから
            10 分以内、コードが出てから 3 分以内）。
          </p>
        ) : null}
      </form>
    </div>
  );
}
