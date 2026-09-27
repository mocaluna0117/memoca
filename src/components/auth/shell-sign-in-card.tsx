"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopComplete, isHandoffToken, pastedToken } from "@/lib/auth/handoff";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { t } from "@/lib/i18n/ja";

/**
 * Signing in inside the desktop shell, where Google will not have it: in the
 * default browser instead, which comes back to the shell when it is done;
 * or, where the way back does not reach the shell, with the code the
 * browser shows.
 */
export function ShellSignInCard() {
  const canBegin = useClientValue(
    () => typeof window.memocaShell?.beginSignIn === "function",
    false,
  );
  const [code, setCode] = useState("");
  const token = pastedToken(code);

  return (
    <div className="w-full max-w-sm space-y-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.app.name}</h1>
        <p className="text-sm text-muted-foreground">{t.app.tagline}</p>
      </div>

      <div className="space-y-2">
        <Button
          onClick={() => window.memocaShell?.beginSignIn?.()}
          disabled={!canBegin}
          size="lg"
          className="w-full"
        >
          ブラウザでログイン
        </Button>
        <p className="text-xs leading-relaxed text-muted-foreground">
          いつものブラウザで Google にログインします。終わると、ここに戻ります。
        </p>
      </div>

      <form
        className="space-y-2 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          if (isHandoffToken(token)) window.location.assign(desktopComplete(token));
        }}
      >
        <label htmlFor="handoff-code" className="text-xs font-medium">
          コードを貼り付け（ブラウザに表示されたもの）
        </label>
        <div className="flex gap-2">
          <Input
            id="handoff-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <Button type="submit" variant="outline" disabled={!isHandoffToken(token)}>
            ログイン
          </Button>
        </div>
      </form>
    </div>
  );
}
