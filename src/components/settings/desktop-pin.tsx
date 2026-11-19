"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

type AppWindowMode = "hide" | "behind" | "onTop";

const APP_WINDOW_MODES: { value: AppWindowMode; label: string }[] = [
  { value: "hide", label: "隠す（即席メモと同じ）" },
  { value: "behind", label: "後ろに回る（ふつうのウィンドウ）" },
  { value: "onTop", label: "最前面に固定（ピン留め）" },
];

const modeOf = (pinned: boolean, onTop: boolean): AppWindowMode => (!pinned ? "hide" : onTop ? "onTop" : "behind");

/**
 * How Memoca's own window takes another app being clicked, as the app keeps
 * it in two settings (desktop/src-tauri/src/settings.rs): put away
 * (appPinned off), left behind the app clicked (on, as it always was), or
 * kept above the others (appOnTop too). Read again as the window comes to
 * the front, the menu having changed it meanwhile.
 */
function AppWindowChoice({
  pinned,
  onTop,
  mac,
}: {
  pinned: Pinned;
  onTop: Pinned;
  mac: boolean;
}) {
  const [mode, setMode] = useState<AppWindowMode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    const read = () =>
      void Promise.all([pinned.get(), onTop.get()]).then(
        ([kept, above]) => {
          if (current) setMode(modeOf(kept, above));
        },
        () => undefined,
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      current = false;
      window.removeEventListener("focus", read);
    };
  }, [pinned, onTop]);

  if (mode === null) return null;

  const change = async (next: AppWindowMode) => {
    const before = mode;
    setBusy(true);
    setMode(next);
    try {
      // On top first, then kept out: not on top for a moment while put away.
      const above = await onTop.set(next === "onTop");
      const kept = await pinned.set(next !== "hide");
      setMode(modeOf(kept, above));
    } catch {
      setMode(before);
    } finally {
      setBusy(false);
    }
  };

  const close = mac ? "Esc・⌘W・ホットキー" : "Esc・ホットキー";
  return (
    <div className="space-y-1">
      <Label htmlFor="desktop-app-window" className="text-sm font-normal">
        Memoca のウィンドウ：ほかのアプリをクリックしたとき
      </Label>
      <Select value={mode} disabled={busy} onValueChange={(value) => void change(value as AppWindowMode)}>
        <SelectTrigger id="desktop-app-window" className="w-64" aria-label="Memoca のウィンドウ：ほかのアプリをクリックしたとき">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {APP_WINDOW_MODES.map((each) => (
            <SelectItem key={each.value} value={each.value}>
              {each.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {mac
          ? `「最前面に固定」は、即席メモのピン留めと同じく、ほかのアプリの上に出したままにします（ホットキー 1 回で隠れます）。「隠す」以外では、即席メモを隠しても閉じません。どれでも ${close}で閉じられます。`
          : `「最前面に固定」は、即席メモのピン留めと同じく、ほかのアプリの上に出したままにします（ホットキー 1 回で隠れます）。どれでも ${close}で閉じられます。`}
      </p>
    </div>
  );
}

/**
 * The desktop app's windows: the quick note's ピン留め; how Memoca's own
 * takes another app being clicked (from 0.4.17: kept out or not; from
 * 0.4.18, on top too); and, on a Mac, whether Memoca's own is let go of
 * while memory is short (from 0.4.17). Not in a browser; from an app
 * before 0.4.16, where the menu has the quick note's pin.
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
        {`オンにすると、ほかのアプリをクリックしても即席メモは隠れず、ほかのアプリの上に出したままになります。オフなら隠れます。どちらでも Esc・×・ホットキー（1 回）で隠せます。`}
      </PinRow>
      {shell.appPinned && shell.appOnTop ? (
        <AppWindowChoice pinned={shell.appPinned} onTop={shell.appOnTop} mac={mac} />
      ) : shell.appPinned ? (
        <PinRow id="desktop-pin-app" label="Memoca のウィンドウを、ほかをクリックしても閉じない" pinned={shell.appPinned}>
          {`オフなら即席メモと同じく、ほかのアプリをクリックすると閉じます。どちらでも ${close}で閉じられます。アプリが新しい版に更新されると、ほかのアプリの上に出したままにする（最前面に固定）こともできるようになります。`}
        </PinRow>
      ) : (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Memoca のウィンドウの出し方は、アプリが新しい版に更新されると、ここで選べるようになります。
        </p>
      )}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {where}の ⚡ アイコンのメニューでも、同じように切り替えられます。
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
