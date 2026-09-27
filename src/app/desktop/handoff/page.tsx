import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Handoff } from "@/components/desktop/handoff";
import { HandoffProblem } from "@/components/desktop/problem";
import { desktopSignIn, isHandoffState } from "@/lib/auth/handoff";
import { isAuthenticated } from "@/lib/auth/server";

export const metadata: Metadata = { title: "デスクトップ版に戻る" };

/** In the browser, signed in: hand this browser's session over to the desktop shell. */
export default async function DesktopHandoffPage({ searchParams }: PageProps<"/desktop/handoff">) {
  const { state } = await searchParams;
  if (!isHandoffState(state)) {
    return (
      <HandoffProblem>
        このリンクは使えません。デスクトップ版の Memoca から、もう一度ログインを始めてください。
      </HandoffProblem>
    );
  }
  if (!(await isAuthenticated())) redirect(desktopSignIn(state));
  return <Handoff state={state} />;
}
