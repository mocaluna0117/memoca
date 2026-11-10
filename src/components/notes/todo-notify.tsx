"use client";

import { useConvex } from "convex/react";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { api } from "@convex/_generated/api";
import { Tip } from "@/components/notes/quick-tip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
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

/** A map of the Todo's, followed: its entries as they are, a new Map each change. */
function useMapEntries(map: Y.Map<string>): Map<string, string> {
  const [entries, setEntries] = useState(() => entriesOf(map));
  useEffect(() => {
    const changed = () => setEntries(entriesOf(map));
    map.observe(changed);
    changed();
    return () => map.unobserve(changed);
  }, [map]);
  return entries;
}

const STATE_TEXT: Record<PushState, string> = {
  unsupported: "このブラウザーでは受け取れません。",
  needsInstall:
    "iPhone・iPad では、Safari の共有メニューから「ホーム画面に追加」した memoca で受け取れます（iOS 16.4 以降）。",
  denied: "通知が許可されていません。ブラウザーか端末の設定で、memoca の通知を許可してください。",
  off: "",
  on: "",
};

/** The desktop app's window: its own notifications come with an update of the app. */
const isDesktopApp = () => typeof window !== "undefined" && !!window.memocaShell;

const noSubscribe = () => () => {};

/**
 * The Todo's bell: whether this device is told of its dues (asked of the
 * browser, and given to the server), and the times every item is told of,
 * the account's (on every device), each item's own being in its due's picker.
 */
export function TodoNotify({ doc }: { doc: Y.Doc }) {
  const convex = useConvex();
  const notify = doc.getMap<string>(NOTIFY_MAP);
  const entries = useMapEntries(notify);
  const desktop = useSyncExternalStore(noSubscribe, isDesktopApp, () => false);
  const [state, setState] = useState<PushState | null>(null);
  // The server has no key to sign its pushes with (not set up yet): none can be sent.
  const [noKey, setNoKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void Promise.all([
      pushState().catch((): PushState => "unsupported"),
      convex.query(api.pushSubscriptions.publicKey, {}).catch(() => undefined),
    ]).then(([now, key]) => {
      if (!current) return;
      setState(now);
      setNoKey(key === null);
    });
    return () => {
      current = false;
    };
  }, [open, convex]);

  const chosen = defaultTimings(entries);
  const on = entries.get(ON_KEY) === "1";

  const toggleDevice = async (wanted: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      if (wanted) {
        const now = await turnOn(convex);
        setState(now);
        if (now === "on" && notify.get(ON_KEY) !== "1") {
          // The account's reminders worked out and sent from now on, by whichever device changes the Todo.
          doc.transact(() => notify.set(ON_KEY, "1"), TODO_DUE);
        }
      } else {
        await turnOff(convex);
        setState("off");
      }
    } catch {
      setFailed(true);
      setState(await pushState().catch((): PushState => "unsupported"));
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

  const Icon = state === "on" || (on && chosen.length > 0) ? BellRing : Bell;
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
              この端末で通知を受け取る
            </label>
            {busy ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <Switch
                id="todo-notify-device"
                checked={state === "on"}
                disabled={
                  desktop ||
                  (noKey && state !== "on") ||
                  state === null ||
                  state === "unsupported" ||
                  state === "needsInstall" ||
                  state === "denied"
                }
                onCheckedChange={(wanted) => void toggleDevice(wanted)}
              />
            )}
          </div>
          {desktop ? (
            <p className="text-xs text-muted-foreground">
              デスクトップ版での通知は、アプリの次の更新で受け取れるようになります。ここで選んだ時刻は、スマホなど同じアカウントのほかの端末に届く通知にも使われます。
            </p>
          ) : noKey && state !== "on" ? (
            <p className="text-xs text-muted-foreground">通知を送る準備ができていません。しばらくしてからお試しください。</p>
          ) : state && STATE_TEXT[state] ? (
            <p className="text-xs text-muted-foreground">{STATE_TEXT[state]}</p>
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
