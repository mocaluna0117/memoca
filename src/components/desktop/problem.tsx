import Link from "next/link";

/** Why this step of signing the desktop shell in cannot go on, and where to start again. */
export function HandoffProblem({ children }: { children: string }) {
  return (
    <div className="max-w-sm space-y-4">
      <h1 className="text-lg font-semibold">ログインを続けられません</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
      <Link href="/app" className="text-sm underline underline-offset-2">
        Memoca を開く
      </Link>
    </div>
  );
}
