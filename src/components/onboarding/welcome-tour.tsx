"use client";

import { useMutation } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { CloudUpload, FileText, PenLine, Sparkles, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { db } from "@/lib/db";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { PRACTICE_TITLE, rememberWelcomeSeen, welcomeOff, welcomeSeenHere } from "@/lib/welcome";

/** Said in the page to show the welcome again (the settings' 「はじめの案内をもう一度見る」). */
export const SHOW_WELCOME = "memoca:show-welcome";

/** Where the person is: a phone, a browser on a computer, or the desktop app. */
type Surface = "phone" | "browser" | "desktop";

const surfaceOf = (): Surface =>
  window.memocaShell ? "desktop" : window.matchMedia("(max-width: 767px)").matches ? "phone" : "browser";

/** The desktop app's hotkey for the quick note, as it starts. */
const hotkeyOf = () => (window.memocaShell?.platform === "windows" ? "Ctrl＋Shift＋M" : "⌘⇧M");

type Step = { icon: typeof Zap; title: string; body: ReactNode };

function stepsFor(surface: Surface, practice: boolean, hotkey: string): Step[] {
  return [
    {
      icon: Sparkles,
      title: "Memoca へようこそ",
      body: (
        <>
          <p>思いついたことをすぐ書いて、あとでゆっくり整理できるメモアプリです。</p>
          {practice ? (
            <p>Inbox に、練習用のメモ「{PRACTICE_TITLE}」を用意しました。</p>
          ) : null}
        </>
      ),
    },
    {
      icon: Zap,
      title: "思いついたら、すぐ書く",
      body: (
        <>
          <p>
            {surface === "phone"
              ? "画面の下の「即席メモ」（⚡）を押すと、すぐに書き始められます。"
              : surface === "desktop"
                ? `どのアプリを使っていても、ホットキー（はじめは ${hotkey}）で即席メモが出ます。メニューバーの ⚡ からも開けます。`
                : "サイドバーの「即席メモ」（⚡）から、すぐに書き始められます。"}
          </p>
          <p>書いたら「保存」で、ふつうのメモになります。チェックリストの Todo も使えます。</p>
        </>
      ),
    },
    {
      icon: PenLine,
      title: "かんたんな書き方",
      body: (
        <>
          <p>
            行のはじめに「- 」と打つと箇条書き、「[] 」でチェック項目、「# 」で見出しになります。
          </p>
          <p>「/」を打つとメニューが出て、見出しや表、画像などを選べます。日本語入力のままでも使えます。</p>
        </>
      ),
    },
    {
      icon: CloudUpload,
      title: "どの端末でも、同じメモ",
      body: (
        <>
          <p>スマホでもパソコンでも、同じアカウントでログインすると同じメモが見られます。</p>
          <p>電波がないときも書けて、つながったら自動で送られます。</p>
        </>
      ),
    },
  ];
}

/**
 * The welcome, once an account (whichever device it is first seen on): a
 * few cards on what is used most, for someone new to the app, and the way
 * to the note made to try things in (an account just made) or to 使い方.
 * Not in the quick note's window. Shown again from the settings.
 */
export function WelcomeTour() {
  const { me } = useSync();
  const router = useRouter();
  const markWelcomed = useMutation(api.users.markWelcomed);
  const surface = useClientValue(surfaceOf, "browser");
  const hotkey = useClientValue(hotkeyOf, "⌘⇧M");
  // Asked for again (the settings, 使い方), and closed by this account here.
  const [again, setAgain] = useState(false);
  const [closedBy, setClosedBy] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const userKey = me?.userKey ?? null;
  // Not known yet (a snapshot kept from before the server said): not shown.
  const due =
    userKey !== null &&
    me?.welcomed === false &&
    closedBy !== userKey &&
    !welcomeOff() &&
    !welcomeSeenHere(userKey);
  const open = again || due;
  // The note to try things in, once made (as the account's sync starts).
  const practice = useLiveQuery(
    () =>
      db()
        .notes.filter((note) => note.title === PRACTICE_TITLE && note.deletedAt === null && !note.purged)
        .first(),
    [],
  );

  useEffect(() => {
    const show = () => {
      setStep(0);
      setAgain(true);
    };
    window.addEventListener(SHOW_WELCOME, show);
    return () => window.removeEventListener(SHOW_WELCOME, show);
  }, []);

  const steps = stepsFor(surface, practice !== undefined, hotkey);
  const last = step === steps.length - 1;
  const current = steps[step]!;
  const Icon = current.icon;

  const close = (then?: () => void) => {
    setAgain(false);
    if (userKey) {
      setClosedBy(userKey);
      rememberWelcomeSeen(userKey);
      void markWelcomed({}).catch(() => undefined);
    }
    then?.();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="gap-5 sm:max-w-md" aria-describedby="welcome-body">
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <div className="bg-primary/10 text-primary flex size-14 items-center justify-center rounded-full">
            <Icon className="size-7" aria-hidden />
          </div>
          <DialogTitle className="text-lg">{current.title}</DialogTitle>
          <DialogDescription asChild>
            <div id="welcome-body" className="text-muted-foreground space-y-2 text-sm leading-relaxed">
              {current.body}
            </div>
          </DialogDescription>
        </div>

        <div className="flex justify-center gap-1.5" aria-hidden>
          {steps.map((each, index) => (
            <span
              key={each.title}
              className={index === step ? "bg-primary size-2 rounded-full" : "bg-muted size-2 rounded-full"}
            />
          ))}
        </div>
        <p className="sr-only" aria-live="polite">
          {steps.length} 枚中 {step + 1} 枚目
        </p>

        {last ? (
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            {practice ? (
              <Button className="flex-1" onClick={() => close(() => router.push(`/app?n=${practice.noteId}`))}>
                <FileText aria-hidden />
                練習用のメモを開く
              </Button>
            ) : (
              <Button className="flex-1" onClick={() => close()}>
                はじめる
              </Button>
            )}
            <Button variant="outline" className="flex-1" onClick={() => close(() => router.push("/app/help"))}>
              使い方を見る
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" onClick={() => close()}>
              とばす
            </Button>
            <div className="flex gap-2">
              {step > 0 ? (
                <Button variant="outline" onClick={() => setStep(step - 1)}>
                  もどる
                </Button>
              ) : null}
              <Button onClick={() => setStep(step + 1)}>つぎへ</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
