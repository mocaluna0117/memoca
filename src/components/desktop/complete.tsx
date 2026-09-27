"use client";

import { useEffect, useState } from "react";
import { HandoffProblem } from "@/components/desktop/problem";
import { authClient } from "@/lib/auth/client";
import { tokenFromFragment } from "@/lib/auth/handoff";
import { useClientValue } from "@/lib/hooks/use-client-value";

/** Tokens being exchanged: each one once, however often the page's effect runs. */
const exchanges = new Map<string, Promise<boolean>>();

function exchange(token: string): Promise<boolean> {
  let running = exchanges.get(token);
  if (!running) {
    running = authClient.oneTimeToken.verify({ token }).then(
      ({ error }) => !error,
      () => false,
    );
    exchanges.set(token, running);
  }
  return running;
}

/**
 * In the desktop shell's window: exchanges the token in the address's
 * fragment for a session, and opens the quick note in its place, which
 * takes the address with the token out of the window's history too. Turned
 * down, the token goes from the address all the same.
 */
export function Complete() {
  // Unknown until the page runs in the window: the server never sees it.
  const token = useClientValue<string | null | undefined>(
    () => tokenFromFragment(window.location.hash),
    undefined,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!token) return;
    let current = true;
    void exchange(token).then((signedIn) => {
      if (!current) return;
      if (signedIn) {
        window.location.replace("/quick?window=1");
      } else {
        setFailed(true);
        // The page reads the address again as it shows this: failed comes first.
        window.history.replaceState(null, "", window.location.pathname);
      }
    });
    return () => {
      current = false;
    };
  }, [token]);

  if (failed) {
    return (
      <HandoffProblem>
        ログインできませんでした。コードの期限（3
        分）が切れたか、もう使われています。デスクトップ版から、もう一度ログインを始めてください。
      </HandoffProblem>
    );
  }
  if (token === null) {
    return (
      <HandoffProblem>
        コードが正しくありません。ブラウザに表示されたコードを、もう一度貼り付けてください。
      </HandoffProblem>
    );
  }
  return <p className="text-sm text-muted-foreground">ログインしています…</p>;
}
