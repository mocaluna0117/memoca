"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { CircleCheck, Sparkles } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { formatHotkey, sameHotkey } from "@/lib/desktop/hotkeys";
import {
  GUIDE_DID,
  type GuideDid,
  type GuideState,
  type GuideStep,
  type GuideWindow,
  guideFrom,
  setGuide,
  storedGuide,
} from "@/lib/guide";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { useKeyboardInset } from "@/lib/hooks/use-keyboard-inset";
import { type MemocaShell, SHELL_HIDDEN } from "@/lib/quick/shell";
import { cn } from "@/lib/utils";
import { PRACTICE_TITLE } from "@/lib/welcome";

/** Which window each step is done in; the other says where to go on. */
const WHERE: Record<GuideState["flow"], Partial<Record<GuideStep, GuideWindow>>> = {
  web: {
    intro: "app",
    "open-quick": "app",
    "save-quick": "quick",
    "open-note": "quick",
    bullet: "app",
    slash: "app",
    finish: "app",
  },
  desktop: {
    write: "quick",
    "hide-show": "quick",
    save: "quick",
    "open-app": "quick",
    "app-here": "app",
    hotkey: "app",
    finish: "app",
  },
};

/** What each step points at, to be pressed or typed in (the first of them on screen). */
const TARGET: Partial<Record<GuideStep, string>> = {
  "open-quick": '[data-guide="open-quick"]',
  "save-quick": '[data-guide="quick-save"]',
  "open-note": '[data-guide="quick-open-note"]',
  write: '[aria-label="即席メモ"]',
  save: '[data-guide="quick-save"]',
  "open-app": '[data-guide="quick-open-app"]',
  hotkey: '[data-guide="hotkey-app"]',
};

/** The first of them that is on screen (the sidebar is in the page twice, one hidden). */
function onScreen(selector: string): Element | null {
  for (const element of document.querySelectorAll(selector)) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight) return element;
  }
  return null;
}

type Box = { left: number; top: number; width: number; height: number };
type Place = {
  ring: Box | null;
  atTop: boolean;
  below: number;
  headerBottom: number;
  /** The "/" menu open: the card for after it waits for it to close, rather than go under it. */
  menu: boolean;
};

/** Where the caret is on the screen, if it is in something typed in. */
function caretBox(): DOMRect | null {
  const selection = document.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const box = range.getBoundingClientRect();
  if (box.height > 0) return box;
  const node = range.startContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[contenteditable='true']") ? element.getBoundingClientRect() : null;
}

/**
 * Where the thing pointed at is, and so where the card goes: looked at
 * again as the page moves. With a phone's keyboard up, away from the caret
 * (the "/" menu opens by it), and above the bar on the keyboard.
 */
function usePlace(selector: string | null, keyboard: number): Place {
  const [place, setPlace] = useState<Place>({ ring: null, atTop: false, below: 0, headerBottom: 0, menu: false });
  useEffect(() => {
    let last = "";
    const look = () => {
      const target = selector ? onScreen(selector) : null;
      const box = target?.getBoundingClientRect();
      const ring = box
        ? { left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }
        : null;
      const caret = keyboard > 0 ? caretBox() : null;
      const seen = window.innerHeight - keyboard;
      const atTop = caret
        ? caret.top + caret.height / 2 > seen / 2
        : box
          ? box.top + box.height / 2 > window.innerHeight * 0.55
          : false;
      // A phone's bars, top and foot (the bottom bar, the one on the keyboard): the card between them.
      const nav = onScreen("[data-mobile-nav]");
      const bar = keyboard > 0 ? onScreen("[data-keyboard-bar]") : null;
      const header = onScreen("[data-mobile-header]");
      const next = {
        ring,
        atTop,
        below: (nav ? nav.getBoundingClientRect().height : 0) + (bar ? bar.getBoundingClientRect().height : 0),
        headerBottom: header ? Math.max(0, header.getBoundingClientRect().bottom) : 0,
        menu: onScreen(".bn-suggestion-menu") !== null,
      };
      const said = JSON.stringify(next);
      if (said !== last) {
        last = said;
        setPlace(next);
      }
    };
    const first = window.requestAnimationFrame(look);
    const every = window.setInterval(look, 250);
    return () => {
      window.cancelAnimationFrame(first);
      window.clearInterval(every);
    };
  }, [selector, keyboard]);
  return place;
}

/** The card's buttons leave the caret where it is: in the quick note, the keyboard stays up. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

type Keys = { quick: string; app: string | null };

/** The desktop app's hotkeys as the computer marks them (the app's own, as it is set now). */
function useKeys(shell: MemocaShell | null, step: GuideStep): Keys {
  const platform = shell?.platform ?? "macos";
  const fallback: Keys = { quick: formatHotkey("CmdOrCtrl+Shift+M", platform), app: null };
  const [keys, setKeys] = useState<Keys | null>(null);
  useEffect(() => {
    const hotkeys = shell?.hotkeys;
    if (!hotkeys) return;
    let live = true;
    void hotkeys.get().then(
      (got) => {
        if (!live) return;
        setKeys({
          quick: formatHotkey(got.quick, platform),
          // Memoca's own on the quick note's keys: the quick note's, and none of its own.
          app: sameHotkey(got.app, got.quick, platform) ? null : formatHotkey(got.app, platform),
        });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [shell, platform, step]);
  return keys ?? fallback;
}

/**
 * The guide's card at a step (components/onboarding/guide), and the step
 * waited on: what is pointed at, ringed; done, the next. Not a dialog over
 * the page, which is what the step is done in: a card at its foot (its top,
 * when what it points at is low), with つぎへ for a step not to be done.
 */
export function GuideCard({
  state,
  here,
  shell,
  onStart,
  onEnd,
}: {
  state: GuideState;
  here: GuideWindow;
  shell: MemocaShell | null;
  onStart: () => void;
  onEnd: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const keys = useKeys(shell, state.step);
  const inset = useKeyboardInset();
  const windowed = useClientValue(
    () => here === "quick" && (new URLSearchParams(location.search).get("window") === "1" || !!window.memocaShell),
    false,
  );
  const { flow, step } = state;
  const where = step === "intro" ? (state.startedIn ?? here) : (WHERE[flow][step] ?? here);
  const mine = where === here;
  const place = usePlace(
    mine ? (TARGET[step] ?? null) : flow === "web" && where === "quick" ? TARGET["open-quick"]! : null,
    inset,
  );

  const { asked } = state;
  const go = (next: GuideStep) => setGuide({ flow, step: next, at: Date.now(), done: true, asked });

  // Done, said above the next step's words for a while.
  useEffect(() => {
    if (!state.done) return;
    const timer = window.setTimeout(() => {
      const now = guideFrom(storedGuide());
      if (now && now.step === step && now.done) setGuide({ ...now, done: false });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [state.done, step]);

  // What the step waits on, in the window it is done in.
  useEffect(() => {
    if (!mine) return;
    const advance = (next: GuideStep) => setGuide({ flow, step: next, at: Date.now(), done: true, asked });
    const did = (handle: (detail: GuideDid) => void) => {
      const listener = (event: Event) => handle((event as CustomEvent<GuideDid>).detail);
      window.addEventListener(GUIDE_DID, listener);
      return () => window.removeEventListener(GUIDE_DID, listener);
    };
    const clicked = (selector: string, next: GuideStep) => {
      const listener = (event: Event) => {
        if ((event.target as Element | null)?.closest?.(selector)) advance(next);
      };
      document.addEventListener("click", listener, true);
      return () => document.removeEventListener("click", listener, true);
    };
    const every = (seen: () => boolean, next: GuideStep) => {
      const timer = window.setInterval(() => {
        if (seen()) advance(next);
      }, 400);
      return () => window.clearInterval(timer);
    };
    switch (step) {
      case "save-quick":
      case "save":
        return did((detail) => {
          if (detail.what !== "quick-saved") return;
          if (flow === "web") advance(detail.windowed ? "open-note" : "bullet");
          else advance(shell?.showApp ? "open-app" : "finish");
        });
      case "open-note":
        return clicked('[data-guide="quick-open-note"]', "bullet");
      case "bullet":
        return every(() => {
          const node = document.getSelection()?.anchorNode;
          const element = node instanceof Element ? node : (node?.parentElement ?? null);
          const block = element?.closest(".bn-editor") ? element.closest("[data-content-type]") : null;
          return block?.getAttribute("data-content-type") === "bulletListItem";
        }, "slash");
      case "slash":
        return every(() => onScreen(".bn-suggestion-menu") !== null, "finish");
      case "write": {
        const typed = (event: Event) => {
          if ((event.target as Element | null)?.closest?.('[aria-label="即席メモ"]')) advance("hide-show");
        };
        document.addEventListener("input", typed, true);
        return () => document.removeEventListener("input", typed, true);
      }
      case "hide-show": {
        // Put away (the hotkey, or a click elsewhere), then out again however
        // it came: the window in view, or typed in.
        let away = false;
        const hidden = () => {
          away = true;
        };
        const back = () => {
          if (away && document.visibilityState === "visible") advance("save");
        };
        window.addEventListener(SHELL_HIDDEN, hidden);
        window.addEventListener("focus", back);
        document.addEventListener("visibilitychange", back);
        document.addEventListener("input", back, true);
        return () => {
          window.removeEventListener(SHELL_HIDDEN, hidden);
          window.removeEventListener("focus", back);
          document.removeEventListener("visibilitychange", back);
          document.removeEventListener("input", back, true);
        };
      }
      case "open-app":
        return clicked('[data-guide="quick-open-app"]', "app-here");
      case "hotkey":
        return did((detail) => {
          if (detail.what === "hotkey-set") advance("finish");
        });
      default:
        return;
    }
  }, [mine, flow, step, shell, asked]);

  const content = mine ? stepContent() : elsewhere();
  if (!content) return null;
  // Just tried, the "/" menu: the last card once it is closed.
  if (step === "finish" && flow === "web" && place.menu) return null;
  const { title, body, primary, secondary, endLabel = "終わる", icon } = content;

  function stepContent(): Content | null {
    const next = (to: GuideStep) => ({ label: "つぎへ", run: () => go(to) });
    switch (step) {
      case "intro":
        return {
          icon: true,
          title: "Memoca へようこそ",
          body:
            flow === "web" ? (
              <p>
                思いついたことをすぐ書いて、あとでゆっくり整理できるメモアプリです。よく使う操作を、実際にやってみましょう（1 分ほど）。
              </p>
            ) : (
              <p>デスクトップ版の即席メモの使い方を、実際にやってみましょう（1 分ほど）。</p>
            ),
          primary: { label: "やってみる", run: onStart },
          endLabel: "あとで",
        };
      case "open-quick":
        return {
          body: <p>思いついたことは「即席メモ」にすぐ書けます。枠で囲んだ ⚡「即席メモ」を押してみましょう。</p>,
          secondary: next("save-quick"),
        };
      case "save-quick":
        return {
          body: <p>何か書いて、「保存」を押してみましょう。メモになって、Inbox に入ります。</p>,
          secondary: next(windowed ? "open-note" : "bullet"),
        };
      case "open-note":
        return {
          body: <p>保存できました。下の「メモを開く」で、保存したメモを開いてみましょう。</p>,
          secondary: next("bullet"),
        };
      case "bullet":
        return {
          body: (
            <p>
              メモの本文で、行のはじめに「- 」（ハイフンと空白）と打ってみましょう。箇条書きになります。日本語入力のままなら「ー」と空白でもできます。
            </p>
          ),
          secondary: next("slash"),
        };
      case "slash":
        return {
          body: <p>次は「/」（スラッシュ）を打ってみましょう。見出しやチェックリスト、表などのメニューが出ます。</p>,
          secondary: next("finish"),
        };
      case "write":
        return {
          body: <p>ここが即席メモです。どのアプリを使っていても、すぐ書けます。何か書いてみましょう。</p>,
          secondary: next("hide-show"),
        };
      case "hide-show":
        return {
          body: (
            <>
              <p>
                <Key>{keys.quick}</Key> を押すと、この窓が隠れます。隠れたら、もう一度 <Key>{keys.quick}</Key>{" "}
                を押して出してみましょう。
              </p>
              <p className="text-muted-foreground text-xs">
                キーが効かないときは、{shell?.platform === "windows" ? "タスクバーの右下" : "メニューバー"}の ⚡ からも出せます。
              </p>
            </>
          ),
          secondary: next("save"),
        };
      case "save":
        return {
          body: (
            <p>
              書いた内容は、隠しても残っています。「保存」を押すと、メモになって Inbox に入ります（保存しなくても、書きかけは残ります）。
            </p>
          ),
          secondary: next(shell?.showApp ? "open-app" : "finish"),
        };
      case "open-app":
        return {
          body: (
            <p>右上の枠で囲んだボタン（Memoca を開く）で、メモの一覧や編集ができる、Memoca 全体の窓が開きます。押してみましょう。</p>
          ),
          secondary: next("app-here"),
        };
      case "app-here":
        return {
          body: (
            <>
              <p>これが Memoca 全体の窓です。保存したメモは、サイドバーの Inbox に入っています。</p>
              {shell?.hotkeys ? <p>この窓を出すホットキーも決められます。設定を開いてみましょう。</p> : null}
            </>
          ),
          primary: shell?.hotkeys
            ? {
                label: "設定を開く",
                run: () => {
                  setGuide({ flow, step: "hotkey", at: Date.now(), asked });
                  router.push("/app/settings#hotkeys");
                },
              }
            : { label: "つぎへ", run: () => go("finish") },
        };
      case "hotkey": {
        const onSettings = pathname === "/app/settings";
        const mac = shell?.platform !== "windows";
        return {
          body: keys.app ? (
            <p>
              全体の窓のホットキーは <Key>{keys.app}</Key> です。ここの「変更」で、いつでも変えられます。
            </p>
          ) : (
            <p>
              「Memoca 全体のウィンドウを開く・隠す」の「変更」を押して、この窓に使いたいキーを押してみましょう（
              {mac ? "⌘・⌃・⌥" : "Ctrl・Alt"} のどれかといっしょに）。
            </p>
          ),
          primary: onSettings ? undefined : { label: "設定を開く", run: () => router.push("/app/settings#hotkeys") },
          secondary: next("finish"),
        };
      }
      case "finish":
        return {
          icon: true,
          title: "これで基本はおしまいです",
          body:
            flow === "web" ? (
              <p>
                スマホでもパソコンでも、同じアカウントでログインすれば同じメモが見られます。困ったときは、サイドバーの「？」（使い方）を見てください。
              </p>
            ) : (
              <p>
                <Key>{keys.quick}</Key> で即席メモ
                {keys.app ? (
                  <>
                    、<Key>{keys.app}</Key> で全体の窓
                  </>
                ) : null}
                を、どのアプリからでも出せます。くわしくは、サイドバーの「？」（使い方）へ。
              </p>
            ),
          primary: {
            label: "使い方を見る",
            run: () => {
              onEnd();
              router.push("/app/help");
            },
          },
          extra: flow === "web" ? <PracticeButton onOpen={onEnd} /> : null,
          endLabel: "閉じる",
        };
      default:
        return null;
    }
  }

  /** In the other window: where the guide goes on. */
  function elsewhere(): Content | null {
    if (step === "intro") return null;
    if (flow === "web") {
      return where === "quick"
        ? { body: <p>即席メモで何か書いて、「保存」を押してみましょう。枠で囲んだ ⚡「即席メモ」から開けます。</p> }
        : {
            body: <p>続きは、Memoca のメモの画面です。</p>,
            primary: windowed ? undefined : { label: "メモの画面へ", run: () => router.push("/app") },
          };
    }
    return where === "quick"
      ? {
          body: (
            <p>
              続きは即席メモの窓です（<Key>{keys.quick}</Key> で出せます）。
            </p>
          ),
          primary: shell?.showQuick ? { label: "即席メモを出す", run: () => shell.showQuick?.() } : undefined,
        }
      : {
          body: <p>続きは Memoca 全体の窓です。</p>,
          primary: shell?.showApp ? { label: "全体の窓を開く", run: () => shell.showApp?.() } : undefined,
        };
  }

  const ring = mine || (flow === "web" && where === "quick") ? place.ring : null;
  const side = place.atTop
    ? { top: place.headerBottom ? `${place.headerBottom + 8}px` : "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }
    : { bottom: `calc(env(safe-area-inset-bottom, 0px) + ${place.below + inset + 12}px)` };

  return (
    <>
      {ring ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] animate-pulse rounded-lg ring-2 ring-sky-500 shadow-[0_0_0_6px_rgba(14,165,233,0.28)]"
          style={ring}
        />
      ) : null}
      <section
        aria-label="はじめの案内"
        className={cn(
          "bg-popover text-popover-foreground fixed inset-x-0 z-[60] mx-auto w-[min(26rem,calc(100vw-1.5rem))] space-y-3 rounded-xl border p-4 shadow-lg",
        )}
        style={side}
      >
        {state.done ? (
          <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
            <CircleCheck className="size-4" aria-hidden />
            できました
          </p>
        ) : null}
        {title ? (
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {icon ? <Sparkles className="text-primary size-4" aria-hidden /> : null}
            {title}
          </h2>
        ) : null}
        <div className="space-y-1.5 text-sm leading-relaxed" aria-live="polite">
          {body}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onMouseDown={keepFocus} onClick={onEnd}>
            {endLabel}
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {content.extra}
            {secondary ? (
              <Button variant="outline" size="sm" onMouseDown={keepFocus} onClick={secondary.run}>
                {secondary.label}
              </Button>
            ) : null}
            {primary ? (
              <Button size="sm" onMouseDown={keepFocus} onClick={primary.run}>
                {primary.label}
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

type Action = { label: string; run: () => void };
type Content = {
  title?: string;
  icon?: boolean;
  body: ReactNode;
  primary?: Action;
  secondary?: Action;
  extra?: ReactNode;
  endLabel?: string;
};

function Key({ children }: { children: ReactNode }) {
  return <kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono text-[0.85em] whitespace-nowrap">{children}</kbd>;
}

/** The note made to try things in, when the account has it: opened from the last card. */
function PracticeButton({ onOpen }: { onOpen: () => void }) {
  const router = useRouter();
  const practice = useLiveQuery(
    () =>
      db()
        .notes.filter((note) => note.title === PRACTICE_TITLE && note.deletedAt === null && !note.purged)
        .first(),
    [],
  );
  if (!practice) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onMouseDown={keepFocus}
      onClick={() => {
        onOpen();
        router.push(`/app?n=${practice.noteId}`);
      }}
    >
      練習用のメモを開く
    </Button>
  );
}
