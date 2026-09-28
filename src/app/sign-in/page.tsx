import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ShellSignInCard } from "@/components/auth/shell-sign-in-card";
import { SignInCard } from "@/components/auth/sign-in-card";
import { shellAgent } from "@/lib/auth/handoff";
import { HOME, safeNext } from "@/lib/auth/next";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "ログイン" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const next = safeNext((await searchParams).next) ?? HOME;
  // The desktop shell's window, where Google turns a sign-in away.
  const shell = shellAgent((await headers()).get("user-agent"));
  return (
    // The shell's window is small (420×360): little room to spare around the card.
    <main
      className={cn(
        "flex flex-1 flex-col items-center justify-center px-5",
        shell ? "gap-4 py-5" : "gap-8 py-16",
      )}
    >
      {shell ? <ShellSignInCard /> : <SignInCard next={next} />}
      <p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
        ログインすると
        <Link href="/terms" className="underline underline-offset-2">
          利用規約
        </Link>
        と
        <Link href="/privacy" className="underline underline-offset-2">
          プライバシーポリシー
        </Link>
        に同意したものとみなします。
      </p>
    </main>
  );
}
