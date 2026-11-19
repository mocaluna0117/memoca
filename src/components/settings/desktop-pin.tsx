"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useClientValue } from "@/lib/hooks/use-client-value";
import type { MemocaShell } from "@/lib/quick/shell";

const shellOf = () => window.memocaShell ?? null;

type Pinned = NonNullable<MemocaShell["pinned"]>;

/**
 * One window's ピン留め, as the menu bar icon's menu has it: read again as the
 * window comes to the front, the menu having changed it meanwhile.
 */
function PinRow({ id, label, pinned, children }: { id: string; label: string; pinned: Pinned; children: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
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
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Switch id={id} checked={on} disabled={busy} onCheckedChange={(next) => void change(next)} />
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * The desktop app's windows: ピン留め, one for each, the quick note's and
 * Memoca's own (from 0.4.17), pinned staying out when another app is
 * clicked, put away then if not; and, on a Mac, whether Memoca's own is
 * let go of while memory is short (from 0.4.17). Not in a browser; from an
 * app before 0.4.16, where the menu has the quick note's pin.
 */
export function DesktopPin() {
  const shell = useClientValue(shellOf, null);
  if (!shell) return null;
  const mac = shell.platform === "macos";
  const where = mac ? "メニューバー" : "タスクバー";
  if (!shell.pinned) {
    return (
      <p className="text-muted-foreground text-sm leading-relaxed">
        アプリが新しい版に更新されると、ここで切り替えられるようになります。それまでは、{where}の ⚡
        アイコンのメニューの「ピン留め」から切り替えられます。
      </p>
    );
  }
  const close = mac ? "Esc・⌘W・ホットキー" : "Esc・ホットキー";
  return (
    <div className="space-y-4">
      <PinRow id="desktop-pin-quick" label="即席メモをピン留め" pinned={shell.pinned}>
        {`オンにすると、ほかのアプリをクリックしても即席メモは隠れません。オフなら隠れます。どちらでも Esc・×・ホットキー（1 回）で隠せます。`}
      </PinRow>
      {shell.appPinned ? (
        <PinRow id="desktop-pin-app" label="Memoca のウィンドウをピン留め" pinned={shell.appPinned}>
          {mac
            ? `オンにすると、ほかのアプリをクリックしても、即席メモを隠しても、Memoca のウィンドウは閉じません。オフなら即席メモと同じく、ほかのアプリをクリックすると閉じます。どちらでも ${close}で閉じられます。`
            : `オンにすると、ほかのアプリをクリックしても Memoca のウィンドウは閉じません。オフなら即席メモと同じく、ほかのアプリをクリックすると閉じます。どちらでも ${close}で閉じられます。`}
        </PinRow>
      ) : (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Memoca のウィンドウのピン留めは、アプリが新しい版に更新されると、ここで切り替えられるようになります。
        </p>
      )}
      <p className="text-xs text-muted-foreground leading-relaxed">
        ピン留めは、{where}の ⚡ アイコンのメニューの「ピン留め」と同じです。
      </p>
      {mac && shell.letGoWhenShort ? (
        <PinRow
          id="desktop-let-go"
          label="メモリが足りないとき、隠れている Memoca のウィンドウを手放す"
          pinned={shell.letGoWhenShort}
        >
          {`オンにすると、Mac がメモリが足りないと知らせているとき、閉じてから 10 分たった Memoca のウィンドウを手放して、メモリを空けます（かなり足りないときは 1 分）。次に開くときは読み込み直すので 1〜2 秒かかり、開いていた金庫は閉じます。オフにすると、いつでもすぐ開けるように、裏で用意したままにします。`}
        </PinRow>
      ) : null}
    </div>
  );
}
