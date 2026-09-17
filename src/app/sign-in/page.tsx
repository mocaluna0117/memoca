import type { Metadata } from "next";
import Link from "next/link";
import { SignInCard } from "@/components/auth/sign-in-card";

export const metadata: Metadata = { title: "ログイン" };

export default function SignInPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-5 py-16">
      <SignInCard />
      <p className="text-muted-foreground max-w-sm text-center text-xs leading-relaxed">
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
