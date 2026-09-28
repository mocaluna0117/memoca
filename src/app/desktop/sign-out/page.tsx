import type { Metadata } from "next";
import { headers } from "next/headers";
import { SignOut } from "@/components/desktop/sign-out";
import { HandoffProblem } from "@/components/desktop/problem";
import { shellAgent } from "@/lib/auth/handoff";

export const metadata: Metadata = { title: "ログアウト" };

/** In the desktop shell's window, from its menu: signs the window out. */
export default async function DesktopSignOutPage() {
  if (!shellAgent((await headers()).get("user-agent"))) {
    return (
      <HandoffProblem>この画面は、デスクトップ版の Memoca の中でだけ使えます。</HandoffProblem>
    );
  }
  return <SignOut />;
}
