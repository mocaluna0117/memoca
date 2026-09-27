import type { Metadata } from "next";
import { headers } from "next/headers";
import { Complete } from "@/components/desktop/complete";
import { HandoffProblem } from "@/components/desktop/problem";
import { shellAgent } from "@/lib/auth/handoff";

export const metadata: Metadata = { title: "ログイン" };

/**
 * In the desktop shell's window: exchange the token (in the fragment, never
 * seen here) for a session. Nowhere else: a link with someone else's token,
 * opened in a browser, would sign it in to that other account without a
 * word.
 */
export default async function DesktopCompletePage() {
  if (!shellAgent((await headers()).get("user-agent"))) {
    return (
      <HandoffProblem>この画面は、デスクトップ版の Memoca の中でだけ使えます。</HandoffProblem>
    );
  }
  return <Complete />;
}
