"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useClientValue } from "@/lib/hooks/use-client-value";

const shellOf = () => window.memocaShell ?? null;

/**
 * The desktop app's ピン留め, as its menu bar icon's menu has it: the quick
 * note kept out when another app is clicked, and Memoca's own window kept
 * out as the quick note is put away. Read again as the window comes to the
 * front, the menu having changed it meanwhile. Not in a browser; from an
 * app before 0.4.16, where the menu has it.
 */
export function DesktopPin() {
  const shell = useClientValue(shellOf, null);
  const pinned = shell?.pinned ?? null;
  const mac = (shell?.platform ?? "macos") === "macos";
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pinned) return;
    let current = true;
    const read = () =>
      void pinned.get().then(
        (got) => {
          if (current) setOn(got);
        },
        () => undefined,
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      current = false;
      window.removeEventListener("focus", read);
    };
  }, [pinned]);

  if (!shell) return null;
  const where = mac ? "メニューバー" : "タスクバー";
  if (!pinned) {
    return (
      <p className="text-muted-foreground text-sm leading-relaxed">
        アプリが新しい版に更新されると、ここで切り替えられるようになります。それまでは、{where}の ⚡
        アイコンのメニューの「ピン留め」から切り替えられます。
      </p>
    );
  }
  if (on === null) return null;

  const change = async (next: boolean) => {
    setBusy(true);
    setOn(next);
    try {
      setOn(await pinned.set(next));
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Switch id="desktop-pin" checked={on} disabled={busy} onCheckedChange={(next) => void change(next)} />
        <Label htmlFor="desktop-pin" className="text-sm font-normal">
          ピン留め（勝手に閉じない）
        </Label>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {mac
          ? "ほかのアプリをクリックしても即席メモの窓は隠れず、即席メモを隠しても Memoca のウィンドウは閉じません。即席メモは、Esc・×・ホットキー（1 回）で隠れます。"
          : "ほかのアプリをクリックしても即席メモの窓は隠れません。Esc・×・ホットキー（1 回）で隠れます。"}
        {where}の ⚡ アイコンのメニューの「ピン留め」と同じです。
      </p>
    </div>
  );
}
