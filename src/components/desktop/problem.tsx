import Link from "next/link";

/**
 * Why this step of signing the desktop shell in cannot go on, and where to
 * go instead: the app, from the browser; its sign-in, in the shell's window.
 */
export function HandoffProblem({
  children,
  inShell = false,
}: {
  children: string;
  inShell?: boolean;
}) {
  return (
    <div className="max-w-sm space-y-4">
      <h1 className="text-lg font-semibold">ログインを続けられません</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
      <Link href={inShell ? "/sign-in" : "/app"} className="text-sm underline underline-offset-2">
        {inShell ? "ログインをやり直す" : "Memoca を開く"}
      </Link>
    </div>
  );
}
