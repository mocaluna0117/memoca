"use client";

import { useEffect, useState } from "react";
import { HandoffProblem } from "@/components/desktop/problem";
import { authClient } from "@/lib/auth/client";
import { isHandoffCode, isHandoffVerifier } from "@/lib/auth/handoff";

type Handoff = { code: string; verifier: string };

/** What the shell hands this page: asked for once, however often the page's effect runs. */
let taking: Promise<Handoff | null> | null = null;

function take(): Promise<Handoff | null> {
  taking ??= Promise.resolve(window.memocaShell?.takeSignIn?.() ?? null).then(
    (given) =>
      given && isHandoffCode(given.code) && isHandoffVerifier(given.verifier) ? given : null,
    () => null,
  );
  return taking;
}

/** Codes being taken: each one once. */
const exchanges = new Map<string, Promise<boolean>>();

function exchange({ code, verifier }: Handoff): Promise<boolean> {
  let running = exchanges.get(code);
  if (!running) {
    running = authClient
      .$fetch("/desktop/exchange", { method: "POST", body: { code, verifier } })
      .then(
        ({ error }) => !error,
        () => false,
      );
    exchanges.set(code, running);
  }
  return running;
}

/**
 * In the desktop shell's window: takes the code the shell hands over, with
 * the verifier it holds, for a session of the window's own, and opens the
 * quick note in this page's place. Given nothing (the page opened by
 * anything but the shell), there is nothing to take.
 */
export function Complete() {
  const [problem, setProblem] = useState<"failed" | "nothing" | null>(null);

  useEffect(() => {
    let current = true;
    void take().then(async (handoff) => {
      if (!current) return;
      if (!handoff) {
        setProblem("nothing");
        return;
      }
      const signedIn = await exchange(handoff);
      if (!current) return;
      if (signedIn) window.location.replace("/quick?window=1");
      else setProblem("failed");
    });
    return () => {
      current = false;
    };
  }, []);

  if (problem === "failed") {
    return (
      <HandoffProblem inShell>
        ログインできませんでした。コードの期限（3
        分）が切れたか、もう使われたか、このデスクトップ版で始めたログインのコードではありません。もう一度ログインしてください。
      </HandoffProblem>
    );
  }
  if (problem === "nothing") {
    return (
      <HandoffProblem inShell>
        続けるログインがありません。「ブラウザでログイン」から始めてください。
      </HandoffProblem>
    );
  }
  return <p className="text-sm text-muted-foreground">ログインしています…</p>;
}
