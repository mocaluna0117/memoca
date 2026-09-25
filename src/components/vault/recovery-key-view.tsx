"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recoveryKeyTail } from "@/lib/crypto/recovery-key";
import { t } from "@/lib/i18n/ja";

/** What the saved file says, so it still makes sense found years later. */
function fileText(recoveryKey: string): string {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return [
    "Memoca 金庫のリカバリーキー",
    recoveryKey,
    `作成日: ${today}`,
    "金庫のパスワードを忘れたときに使います。人に見せないでください。",
    "",
  ].join("\n");
}

async function saveToFile(recoveryKey: string): Promise<void> {
  const file = new File([fileText(recoveryKey)], "memoca-recovery-key.txt", {
    type: "text/plain",
  });
  // A phone has no downloads folder worth the name; the share sheet lets the
  // key go straight into Files or a password manager.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Records that the shown key was kept, without letting a slow or offline
 * request hold the screen: after a few seconds it moves on, and Convex still
 * sends the request once it reconnects. "stale" means a newer key was made
 * elsewhere in the meantime, so the one on screen no longer opens the vault.
 */
export async function recordKeptKey(
  mark: () => Promise<{ status: string }>,
): Promise<"ok" | "stale" | "pending"> {
  const status = await Promise.race([
    mark().then(
      (result) => result.status,
      () => "pending",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 3_000)),
  ]);
  return status === "ok" || status === "stale" ? status : "pending";
}

/**
 * Shows a new recovery key once, then asks for its last four characters.
 *
 * The check is what makes 「保管しました」 true: a key that was only glanced at
 * fails it, and the person is sent back to the key rather than past it. The
 * surrounding dialog must not be dismissable while this is on screen.
 */
export function RecoveryKeyView({
  recoveryKey,
  onConfirmed,
}: {
  recoveryKey: string;
  onConfirmed: () => void | Promise<void>;
}) {
  const [step, setStep] = useState<"show" | "confirm">("show");
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The key exists nowhere else. Leaving or reloading the page now would lose
  // it, so the browser asks first.
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  if (step === "show") {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" aria-hidden />
            リカバリーキーを保管してください
          </DialogTitle>
          <DialogDescription>
            パスワードを忘れたときに金庫を開ける、ただひとつの方法です。この画面を閉じると二度と表示されません。Memoca
            でも復元できないので、紙に書き写すか、パスワード管理アプリに保存してください。
          </DialogDescription>
        </DialogHeader>
        <p
          data-recovery-key
          className="bg-muted rounded-md p-4 text-center font-mono text-sm tracking-wider break-all select-all"
        >
          {recoveryKey}
        </p>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(recoveryKey);
                  toast.success(t.action.copied);
                } catch {
                  toast.error("コピーできませんでした。キーを長押しして選択するか、書き写してください。");
                }
              }}
            >
              {t.action.copy}
            </Button>
            <Button variant="outline" onClick={() => void saveToFile(recoveryKey)}>
              ファイルに保存
            </Button>
          </div>
          <Button onClick={() => setStep("confirm")}>次へ</Button>
        </DialogFooter>
      </>
    );
  }

  const confirm = async () => {
    if (recoveryKeyTail(tail) !== recoveryKeyTail(recoveryKey)) {
      setError("一致しません。保管したキーをもう一度確認してください。");
      return;
    }
    setBusy(true);
    try {
      await onConfirmed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>リカバリーキーの確認</DialogTitle>
        <DialogDescription>保管したキーの、最後の 4 文字を入力してください。</DialogDescription>
      </DialogHeader>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <Label htmlFor="recovery-tail">最後の 4 文字</Label>
        <Input
          id="recovery-tail"
          value={tail}
          onChange={(event) => {
            setTail(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={8}
          className="w-32 font-mono"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "recovery-tail-error" : undefined}
        />
        {error ? (
          <p id="recovery-tail-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => setStep("show")}>
            キーをもう一度表示
          </Button>
          <Button type="submit" disabled={busy || tail.trim().length === 0}>
            確認
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
