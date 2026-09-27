import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInCard } from "@/components/auth/sign-in-card";
import { HandoffProblem } from "@/components/desktop/problem";
import { desktopHandoff, isHandoffState } from "@/lib/auth/handoff";
import { isAuthenticated } from "@/lib/auth/server";

export const metadata: Metadata = { title: "デスクトップ版のログイン" };

/** In the browser: sign in, for the desktop shell, and then hand over to it. */
export default async function DesktopSignInPage({ searchParams }: PageProps<"/desktop/sign-in">) {
  const { state } = await searchParams;
  if (!isHandoffState(state)) {
    return (
      <HandoffProblem>
        このリンクは使えません。デスクトップ版の Memoca から、もう一度ログインを始めてください。
      </HandoffProblem>
    );
  }
  if (await isAuthenticated()) redirect(desktopHandoff(state));
  return (
    <>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        デスクトップ版の Memoca にログインします。ログインが終わると、デスクトップ版に戻ります。
      </p>
      <SignInCard next={desktopHandoff(state)} />
    </>
  );
}
