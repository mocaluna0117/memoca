import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Handoff } from "@/components/desktop/handoff";
import { HandoffProblem } from "@/components/desktop/problem";
import {
  desktopSignIn,
  handoffCheck,
  isHandoffChallenge,
  isHandoffState,
} from "@/lib/auth/handoff";
import { isAuthenticated } from "@/lib/auth/server";

export const metadata: Metadata = { title: "デスクトップ版のログイン" };

/** In the browser, signed in: sign the desktop shell in, with a session of its own. */
export default async function DesktopHandoffPage({ searchParams }: PageProps<"/desktop/handoff">) {
  const { state, challenge } = await searchParams;
  if (!isHandoffState(state) || !isHandoffChallenge(challenge)) {
    return (
      <HandoffProblem>
        このリンクは使えません。デスクトップ版の Memoca から、もう一度ログインを始めてください。
      </HandoffProblem>
    );
  }
  if (!(await isAuthenticated())) redirect(desktopSignIn({ state, challenge }));
  return <Handoff state={state} challenge={challenge} check={await handoffCheck(challenge)} />;
}
