"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { formatHotkey, hotkeyFromEvent, sameHotkey } from "@/lib/desktop/hotkeys";
import type { HotkeyRefusal, ShellHotkeys } from "@/lib/quick/shell";

type Which = "quick" | "app";

const ROWS: { which: Which; label: string }[] = [
  { which: "quick", label: "即席メモを出す・隠す" },
  { which: "app", label: "Memoca 全体のウィンドウを開く・隠す" },
];

/** What a refusal says, for the one being changed. */
function refusalText(refusal: string, which: Which, mac: boolean): string {
  switch (refusal as HotkeyRefusal) {
    case "needsModifier":
      return mac
        ? "⌘・⌃・⌥ のどれかといっしょに押してください（F1〜F24 は 1 つでも使えます）。"
        : "Ctrl・Alt・Windows キーのどれかといっしょに押してください（F1〜F24 は 1 つでも使えます）。";
    case "same":
      return which === "quick"
        ? "Memoca 全体のウィンドウのホットキーと同じです。別のキーにしてください。"
        : "即席メモのホットキーと同じです。別のキーにしてください。";
    case "taken":
      return "ほかのアプリが使っているキーです。別のキーにしてください。";
    case "invalid":
      return "このキーはホットキーにできません。別のキーにしてください。";
    default:
      return "変えられませんでした。もう一度お試しください。";
  }
}

const shellOf = () => window.memocaShell ?? null;

/**
 * The desktop app's hotkeys, changed here and in use at once: 変更, then the
 * keys pressed, recorded by where they are on the keyboard. While they are
 * recorded the app lets go of its hotkeys (the system would take them
 * before this page saw them), and every key is this page's (a Mac's menu
 * would take ⌘M, say). Esc stops. Not in a browser; from an app before
 * 0.4.11, the way to change them there.
 */
export function DesktopHotkeys() {
  const shell = useClientValue(shellOf, null);
  const hotkeys = shell?.hotkeys ?? null;
  const platform = shell?.platform ?? "macos";
  const mac = platform === "macos";
  const [now, setNow] = useState<ShellHotkeys | null>(null);
  const [recording, setRecording] = useState<Which | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ which: Which; text: string } | null>(null);

  useEffect(() => {
    if (!hotkeys) return;
    let current = true;
    void hotkeys.get().then(
      (got) => {
        if (current) setNow(got);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [hotkeys]);

  const save = async (which: Which, keys: string) => {
    if (!hotkeys) return;
    setBusy(true);
    setRefused(null);
    try {
      setNow(await hotkeys.set(which, keys));
    } catch (error) {
      setRefused({ which, text: refusalText(String(error), which, mac) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!hotkeys || !recording) return;
    const which = recording;
    // Recorded: the app has its hotkeys back as it takes the new ones, not before.
    let recorded = false;
    void hotkeys.recording(true).catch(() => undefined);
    const pressed = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || recorded) return;
      const held = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
      if (event.key === "Escape" && !held) {
        setRecording(null);
        return;
      }
      const keys = hotkeyFromEvent(event, platform);
      if (!keys) return;
      recorded = true;
      setRecording(null);
      void (async () => {
        await hotkeys.recording(false).catch(() => undefined);
        await save(which, keys);
      })();
    };
    // Another window, or another app: no keys of this page's to record.
    const away = () => setRecording(null);
    window.addEventListener("keydown", pressed, { capture: true });
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("keydown", pressed, { capture: true });
      window.removeEventListener("blur", away);
      if (!recorded) void hotkeys.recording(false).catch(() => undefined);
    };
    // save is this render's; what it uses is in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotkeys, recording, platform]);

  if (!shell) return null;
  if (!hotkeys) {
    return (
      <p className="text-muted-foreground text-sm leading-relaxed">
        アプリが新しい版に更新されると、ここでホットキーを変えられるようになります。それまでは、メニューバーの ⚡
        アイコンのメニューの「ホットキーを変える（設定ファイルを開く）…」から変えられます。
      </p>
    );
  }
  if (!now) return null;

  const start = (which: Which) => {
    setRefused(null);
    // The keys pressed are recorded, not taken by the button (Enter, Space).
    (document.activeElement as HTMLElement | null)?.blur();
    setRecording(which);
  };

  return (
    <div className="space-y-3">
      {ROWS.map(({ which, label }) => {
        const keys = which === "quick" ? now.quick : now.app;
        const fallback = which === "quick" ? now.quickDefault : now.appDefault;
        const listening = recording === which;
        // Memoca's own on the quick note's keys (as both start): the quick note's.
        const shadowed = which === "app" && sameHotkey(now.app, now.quick, platform);
        return (
          <div key={which} className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{label}</span>
              <div className="flex items-center gap-2">
                {listening ? (
                  <span className="text-muted-foreground text-sm" aria-live="polite">
                    キーを押してください（Esc でやめる）
                  </span>
                ) : (
                  <kbd
                    className="bg-muted rounded border px-2 py-0.5 font-mono text-sm"
                    aria-label={`${label}のホットキー`}
                  >
                    {formatHotkey(keys, platform)}
                  </kbd>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => (listening ? setRecording(null) : start(which))}
                >
                  {listening ? "やめる" : "変更"}
                </Button>
                {!listening && !sameHotkey(keys, fallback, platform) ? (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save(which, fallback)}>
                    元に戻す
                  </Button>
                ) : null}
              </div>
            </div>
            {shadowed && !listening ? (
              <p className="text-muted-foreground text-xs">
                即席メモと同じキーなので、今は即席メモが使います。別のキーにすると、こちらで使えます。
              </p>
            ) : null}
            {refused?.which === which ? (
              <p role="alert" className="text-destructive text-xs">
                {refused.text}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
