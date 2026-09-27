import type { Metadata } from "next";
import Link from "next/link";
import { SignInCard } from "@/components/auth/sign-in-card";
import { HOME, safeNext } from "@/lib/auth/next";

export const metadata: Metadata = { title: "ログイン" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const next = safeNext((await searchParams).next) ?? HOME;
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-5 py-16">
      <SignInCard next={next} />
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
