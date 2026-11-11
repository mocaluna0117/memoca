"use client";

import { useConvex, useQuery } from "convex/react";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { api } from "@convex/_generated/api";
import { Tip } from "@/components/notes/quick-tip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { type PushState, pushState, turnOff, turnOn } from "@/lib/notify/push";
import {
  DEFAULT_KEY,
  NEEDS_TIME,
  NOTIFY_MAP,
  ON_KEY,
  TIMINGS,
  TIMING_LABEL,
  type Timing,
  defaultTimings,
  entriesOf,
  remindersIn,
  writeTimings,
} from "@/lib/notify/reminders";
import type { ShellReminderState } from "@/lib/quick/shell";
import { DUE_MAP, TODO_DUE } from "@/lib/quick/todo-due";
import { ORIGIN, bodyFragment } from "@/lib/sync/ydoc";

/** How long after the Todo changes its reminders are worked out and sent: once for a run of typing. */
const SEND_AFTER_MS = 1500;
/** What was sent last from this device, so that the same is not sent again as the Todo opens. */
const SENT_KEY = "memoca:reminders-sent";

const readSent = () => {
  try {
    return localStorage.getItem(SENT_KEY);
  } catch {
    return null;
  }
};
const writeSent = (sent: string) => {
  try {
    localStorage.setItem(SENT_KEY, sent);
  } catch {
    // Sent again next time.
  }
};

/**
 * The Todo's reminders, sent to the server as this device changes the Todo
 * (its items, their dues, the times chosen), a moment after: worked out
 * whole from the Todo as it is, and sent only if they differ from what this
 * device sent last. Also as the Todo opens (what failed to go before), as
 * the network comes back, and as the page is put away. Not before a device
 * of the account asked for them (ON_KEY): no calls for those who never do.
 * What another device changes, it sends itself.
 */
export function useSendReminders(doc: Y.Doc | null) {
  const convex = useConvex();
  useEffect(() => {
    if (!doc) return;
    const body = bodyFragment(doc);
    const dues = doc.getMap<string>(DUE_MAP);
    const notify = doc.getMap<string>(NOTIFY_MAP);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sending = false;
    let again = false;
    const send = async () => {
      clearTimeout(timer);
      timer = undefined;
      if (notify.get(ON_KEY) !== "1") return;
      if (sending) {
        again = true;
        return;
      }
      const reminders = remindersIn(doc, DUE_MAP, Date.now());
      const sent = JSON.stringify(reminders);
      if (sent === readSent()) return;
      sending = true;
      try {
        const result = await convex.mutation(api.reminders.replace, { reminders });
        if (result.status === "ok") writeSent(sent);
      } catch {
        // Offline, or the server not reached: sent as the network comes back, or next change.
      } finally {
        sending = false;
        if (again) {
          again = false;
          void send();
        }
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void send(), SEND_AFTER_MS);
    };
    const changed = (_event: unknown, transaction: Y.Transaction) => {
      // Another device's change: it sends its own.
      if (transaction.origin === ORIGIN.remote || transaction.origin === ORIGIN.load) return;
      soon();
    };
    const now = () => {
      if (timer !== undefined) void send();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") now();
    };
    body.observeDeep(changed);
    dues.observe(changed);
    notify.observe(changed);
    window.addEventListener("online", soon);
    document.addEventListener("visibilitychange", hidden);
    soon();
    return () => {
      body.unobserveDeep(changed);
      dues.unobserve(changed);
      notify.unobserve(changed);
      window.removeEventListener("online", soon);
      document.removeEventListener("visibilitychange", hidden);
      // Leaving the Todo with a change not sent yet: sent now.
      now();
    };
  }, [doc, convex]);
}

/** Said in the page as this computer's choice changes (the bell's switch): read again where it is followed. */
const SHELL_CHANGED = "memoca:shell-reminders-changed";

/** The desktop app's reminders, if it shows them (0.4.10 on). */
const readShell = () => (typeof window === "undefined" ? null : (window.memocaShell?.reminders ?? null));

/**
 * In the desktop app's quick note, signed in: the account's reminders, as
 * the server keeps them, handed to the app (which shows them at their
 * times, desktop/src-tauri/src/reminders.rs) while this computer is to show
 * them; followed only then. The quick note's window is always loaded, the
 * Todo open in it or not, so this is the page's, not the Todo's.
 */
export function useShellReminders(signedIn: boolean) {
  const shell = useClientValue(readShell, null);
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    if (!shell) return;
    let current = true;
    const read = () =>
      void shell.state().then(
        (state) => {
          if (current) setChosen(state === "on" || state === "blocked");
        },
        () => undefined,
      );
    read();
    window.addEventListener(SHELL_CHANGED, read);
    return () => {
      current = false;
      window.removeEventListener(SHELL_CHANGED, read);
    };
  }, [shell]);
  const listed = useQuery(api.reminders.list, shell && chosen && signedIn ? {} : "skip");
  useEffect(() => {
    if (shell && chosen && listed !== undefined) shell.set(listed);
  }, [shell, chosen, listed]);
}

/** A map of the Todo's, followed: its entries as they are, a new Map each change. */function useMapEntries(map: Y.Map<string>): Map<string, string> {
  const [entries, setEntries] = useState(() => entriesOf(map));
  useEffect(() => {
    const changed = () => setEntries(entriesOf(map));
    map.observe(changed);
    changed();
    return () => map.unobserve(changed);
  }, [map]);
  return entries;
}

/** Where this device stands: as a browser's (Web Push), or as the desktop app's. */
type DeviceState = PushState | ShellReminderState;

const STATE_TEXT: Record<DeviceState, string> = {
  unsupported: "このブラウザーでは受け取れません。",
  needsInstall:
    "iPhone・iPad では、Safari の共有メニューから「ホーム画面に追加」した memoca で受け取れます（iOS 16.4 以降）。",
  denied: "通知が許可されていません。ブラウザーか端末の設定で、memoca の通知を許可してください。",
  blocked: "",
  off: "",
  on: "",
};

/** The desktop app's, by its system. */
const SHELL_TEXT: Record<"macos" | "windows", Partial<Record<DeviceState, string>>> = {
  macos: {
    unsupported:
      "この場所にある Memoca では通知を出せません。Memoca を「アプリケーション」フォルダーに入れてから開いてください。",
    blocked:
      "Mac の設定で止められています。システム設定の「通知」で Memoca を選び、「通知を許可」をオンにしてください。",
  },
  windows: {
    unsupported: "このパソコンでは通知を出せません。",
    blocked: "Windows の設定で止められています。設定の「システム」→「通知」で Memoca をオンにしてください。",
  },
};

/** The desktop app's window, of a version before its own notifications: they come with its update. */
const isDesktopApp = () => typeof window !== "undefined" && !!window.memocaShell;

/**
 * The Todo's bell: whether this device is told of its dues (asked of the
 * browser and given to the server, or, in the desktop app, of the app,
 * which shows them itself), and the times every item is told of, the
 * account's (on every device), each item's own being in its due's picker.
 */
export function TodoNotify({ doc }: { doc: Y.Doc }) {
  const convex = useConvex();
  const notify = doc.getMap<string>(NOTIFY_MAP);
  const entries = useMapEntries(notify);
  const desktop = useClientValue(isDesktopApp, false);
  const shell = useClientValue(readShell, null);
  const platform = useClientValue(() => window.memocaShell?.platform ?? "macos", "macos");
  const [state, setState] = useState<DeviceState | null>(null);
  // The server has no key to sign its pushes with (not set up yet): none can be sent to a browser.
  const [noKey, setNoKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const now: Promise<[DeviceState, string | null | undefined]> = shell
      ? shell.state().then(
          (state) => [state, undefined],
          () => ["unsupported", undefined],
        )
      : Promise.all([
          pushState().catch((): PushState => "unsupported"),
          convex.query(api.pushSubscriptions.publicKey, {}).catch(() => undefined),
        ]);
    void now.then(([now, key]) => {
      if (!current) return;
      setState(now);
      setNoKey(key === null);
    });
    return () => {
      current = false;
    };
  }, [open, convex, shell]);

  const chosen = defaultTimings(entries);
  const on = entries.get(ON_KEY) === "1";
  const receiving = state === "on" || state === "blocked";

  /** The account's reminders worked out and sent from now on, by whichever device changes the Todo. */
  const askedFor = () => {
    if (notify.get(ON_KEY) !== "1") doc.transact(() => notify.set(ON_KEY, "1"), TODO_DUE);
  };

  const toggleDevice = async (wanted: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      if (shell) {
        let now: ShellReminderState = "off";
        if (wanted) now = await shell.turnOn();
        else await shell.turnOff();
        setState(now);
        window.dispatchEvent(new Event(SHELL_CHANGED));
        if (now === "on" || now === "blocked") askedFor();
      } else if (wanted) {
        const now = await turnOn(convex);
        setState(now);
        if (now === "on") askedFor();
      } else {
        await turnOff(convex);
        setState("off");
      }
    } catch {
      setFailed(true);
      setState(
        shell
          ? await shell.state().catch((): ShellReminderState => "unsupported")
          : await pushState().catch((): PushState => "unsupported"),
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleTiming = (timing: Timing, wanted: boolean) => {
    const next = new Set(chosen);
    if (wanted) next.add(timing);
    else next.delete(timing);
    doc.transact(() => notify.set(DEFAULT_KEY, writeTimings(next)), TODO_DUE);
  };

  // An old desktop app: none here until it is updated.
  const tooOld = desktop && !shell;
  const said = shell
    ? (state && SHELL_TEXT[platform][state]) ||
      (state === "on" || state === "off" ? "Memoca を終了しているあいだは、このパソコンには届きません。" : "")
    : state
      ? STATE_TEXT[state]
      : "";
  const Icon = receiving || (on && chosen.length > 0) ? BellRing : Bell;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="期日の通知">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="期日の通知">
            <Icon className="size-4" aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" collisionPadding={8} className="w-80 gap-3" aria-label="期日の通知">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="todo-notify-device" className="text-sm font-medium">
              {shell ? "このパソコンで通知を受け取る" : "この端末で通知を受け取る"}
            </label>
            {busy ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <Switch
                id="todo-notify-device"
                checked={receiving}
                disabled={
                  tooOld ||
                  (!shell && noKey && state !== "on") ||
                  state === null ||
                  state === "unsupported" ||
                  state === "needsInstall" ||
                  state === "denied"
                }
                onCheckedChange={(wanted) => void toggleDevice(wanted)}
              />
            )}
          </div>
          {tooOld ? (
            <p className="text-xs text-muted-foreground">
              デスクトップ版での通知は、アプリが新しい版に更新されると受け取れるようになります。ここで選んだ時刻は、スマホなど同じアカウントのほかの端末に届く通知にも使われます。
            </p>
          ) : !shell && noKey && state !== "on" ? (
            <p className="text-xs text-muted-foreground">通知を送る準備ができていません。しばらくしてからお試しください。</p>
          ) : said ? (
            <p className="text-xs text-muted-foreground">{said}</p>
          ) : null}
          {failed ? (
            <p role="alert" className="text-xs text-destructive">
              通知を設定できませんでした。通信できる状態で、もう一度お試しください。
            </p>
          ) : null}
        </div>

        <fieldset className="flex flex-col gap-1.5 border-t pt-3">
          <legend className="pb-1 text-sm font-medium">知らせる時刻</legend>
          {TIMINGS.map((timing) => (
            <label key={timing} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={chosen.includes(timing)}
                onChange={(event) => toggleTiming(timing, event.target.checked)}
              />
              {TIMING_LABEL[timing]}
              {NEEDS_TIME.has(timing) ? (
                <span className="text-xs text-muted-foreground">（時刻のある項目）</span>
              ) : null}
            </label>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            同じアカウントのすべての端末で共通です。項目ごとには、期日を選ぶところで変えられます。
          </p>
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}
