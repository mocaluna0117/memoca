import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

const h = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), useQuery: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvex: () => ({ mutation: h.mutation, query: h.query }),
  useQuery: (...args: unknown[]) => h.useQuery(...args),
}));

import { TodoDuePicker } from "@/components/notes/todo-due-picker";
import { TodoNotify, useSendReminders, useShellReminders } from "@/components/notes/todo-notify";
import { QuickTips } from "@/components/notes/quick-tip";
import type { MemocaShell, ShellReminder, ShellReminderState } from "@/lib/quick/shell";
import { NONE, NOTIFY_MAP, ON_KEY } from "@/lib/notify/reminders";
import { DUE_MAP, TODO_DUE } from "@/lib/quick/todo-due";
import { ORIGIN, bodyFragment } from "@/lib/sync/ydoc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  h.mutation.mockReset();
  h.mutation.mockResolvedValue({ status: "ok" });
  h.query.mockReset();
  h.useQuery.mockReset();
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  delete window.memocaShell;
});

/** The desktop app's window, as the shell makes it (0.4.10 on): its reminders' state kept here. */
function desktopApp(state: ShellReminderState, turnedOn: ShellReminderState = "on") {
  let now = state;
  const reminders = {
    state: vi.fn(async () => now),
    turnOn: vi.fn(async () => (now = turnedOn)),
    turnOff: vi.fn(async () => {
      now = "off";
    }),
    set: vi.fn<(list: readonly ShellReminder[]) => void>(),
  };
  window.memocaShell = { platform: "macos", reminders } as unknown as MemocaShell;
  return reminders;
}

/** A Todo of one item, "牛乳を買う", its block id "a". */
function todo(): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", "a");
  const item = new Y.XmlElement("checkListItem");
  const line = new Y.XmlText();
  item.insert(0, [line]);
  container.insert(0, [item]);
  group.insert(0, [container]);
  bodyFragment(doc).insert(0, [group]);
  line.insert(0, "牛乳を買う");
  return doc;
}

function Sender({ doc }: { doc: Y.Doc }) {
  useSendReminders(doc, "todo-note");
  return null;
}

/** Tomorrow, as a due keeps it. */
const tomorrow = () => {
  const day = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}T18:00`;
};

describe("the Todo's reminders, sent as it is changed here", () => {
  test("none sent before a device of the account asks for them; then the whole of them, once", async () => {
    vi.useFakeTimers();
    const doc = todo();
    await act(async () => root.render(<Sender doc={doc} />));
    doc.transact(() => doc.getMap<string>(DUE_MAP).set("a", tomorrow()), TODO_DUE);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).not.toHaveBeenCalled();

    doc.transact(() => doc.getMap<string>(NOTIFY_MAP).set(ON_KEY, "1"), TODO_DUE);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(1);
    const sent = h.mutation.mock.calls[0]![1] as { reminders: { key: string; title: string }[] };
    expect(sent.reminders.map((each) => each.key)).toContain("a:atTime");
    expect(sent.reminders.every((each) => each.title === "牛乳を買う")).toBe(true);

    // The same again (a change that moves no reminder): not sent.
    doc.transact(
      () => doc.getMap<string>(DUE_MAP).set("a", doc.getMap<string>(DUE_MAP).get("a")!),
      TODO_DUE,
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(1);

    // None for it now: sent, as none.
    doc.transact(() => doc.getMap<string>(NOTIFY_MAP).set("a", NONE), TODO_DUE);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(2);
    expect(h.mutation.mock.calls[1]![1]).toEqual({ reminders: [] });
  });

  test("another device's change is not sent from here: it sends its own", async () => {
    vi.useFakeTimers();
    const doc = todo();
    doc.transact(() => doc.getMap<string>(NOTIFY_MAP).set(ON_KEY, "1"), ORIGIN.remote);
    await act(async () => root.render(<Sender doc={doc} />));
    // As it opens: what this device has, sent once.
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(1);
    doc.transact(() => doc.getMap<string>(DUE_MAP).set("a", tomorrow()), ORIGIN.remote);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(1);
  });

  test("changed back to what this device last sent, after another device changed them: sent again", async () => {
    vi.useFakeTimers();
    const doc = todo();
    doc.transact(() => doc.getMap<string>(NOTIFY_MAP).set(ON_KEY, "1"), TODO_DUE);
    doc.transact(() => doc.getMap<string>(DUE_MAP).set("a", tomorrow()), TODO_DUE);
    await act(async () => root.render(<Sender doc={doc} />));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(1);
    const due = doc.getMap<string>(DUE_MAP).get("a")!;

    // Another device takes the due off: it sends none, and the server has none.
    doc.transact(() => doc.getMap<string>(DUE_MAP).delete("a"), ORIGIN.remote);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(1);

    // Put back here, as it was: what this device last sent, but not what the server has.
    doc.transact(() => doc.getMap<string>(DUE_MAP).set("a", due), TODO_DUE);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(2);
    expect((h.mutation.mock.calls[1]![1] as { reminders: unknown[] }).reminders.length).toBeGreaterThan(0);
  });

  test("not sent (offline): sent again as the network comes back", async () => {
    vi.useFakeTimers();
    h.mutation.mockRejectedValueOnce(new Error("offline"));
    const doc = todo();
    doc.transact(() => doc.getMap<string>(NOTIFY_MAP).set(ON_KEY, "1"), TODO_DUE);
    doc.transact(() => doc.getMap<string>(DUE_MAP).set("a", tomorrow()), TODO_DUE);
    await act(async () => root.render(<Sender doc={doc} />));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("online"));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.mutation).toHaveBeenCalledTimes(2);
  });
});

describe("an item's own reminders, in its due's picker", () => {
  const press = (name: string) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (each) => each.textContent === name,
      );
      if (!button) throw new Error(`no button ${name}`);
      button.click();
    });

  test("as every item, none, or times of its own (from the account's), the hours' only with a time", async () => {
    const onNotify = vi.fn();
    const day = new Date();
    const due = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    await act(async () =>
      root.render(
        <TodoDuePicker
          due={due}
          at={new DOMRect(0, 0, 10, 10)}
          onPick={() => {}}
          onClose={() => {}}
          notify={null}
          defaults={["eve", "morning", "hourBefore", "atTime"]}
          onNotify={onNotify}
        />,
      ),
    );
    const pressed = (name: string) =>
      [...document.querySelectorAll("button")]
        .find((each) => each.textContent === name)
        ?.getAttribute("aria-pressed");
    expect(pressed("いつもどおり")).toBe("true");

    await press("通知しない");
    expect(onNotify).toHaveBeenLastCalledWith(NONE);
    expect(pressed("通知しない")).toBe("true");

    // A day alone: the account's, but the hours'.
    await press("時刻を選ぶ");
    expect(onNotify).toHaveBeenLastCalledWith(["eve", "morning"]);
    const hour = [...document.querySelectorAll("button")].find(
      (each) => each.textContent === "1 時間前",
    );
    expect(hour?.disabled).toBe(true);
    await press("前日 21:00");
    expect(onNotify).toHaveBeenLastCalledWith(["morning"]);

    await press("いつもどおり");
    expect(onNotify).toHaveBeenLastCalledWith(null);
  });
});

describe("in the desktop app", () => {
  const listed: ShellReminder[] = [
    { key: "a:morning", at: Date.now() + 60_000, title: "牛乳を買う", body: "今日が期日です" },
  ];

  function Handing({ signedIn }: { signedIn: boolean }) {
    useShellReminders(signedIn);
    return null;
  }

  test("the account's reminders are handed to the app while this computer is to show them, and followed only then", async () => {
    const shell = desktopApp("off");
    h.useQuery.mockImplementation((_query: unknown, args: unknown) =>
      args === "skip" ? undefined : listed,
    );
    await act(async () => root.render(<Handing signedIn />));
    expect(h.useQuery).toHaveBeenLastCalledWith(expect.anything(), "skip");
    expect(shell.set).not.toHaveBeenCalled();

    // Turned on, from the bell: read again, followed, and handed over.
    await shell.turnOn();
    await act(async () => {
      window.dispatchEvent(new Event("memoca:shell-reminders-changed"));
    });
    expect(h.useQuery).toHaveBeenLastCalledWith(expect.anything(), {});
    expect(shell.set).toHaveBeenLastCalledWith(listed);
  });

  test("chosen but kept from showing by the system's settings: still handed over, so allowing them there is enough", async () => {
    const shell = desktopApp("blocked");
    h.useQuery.mockImplementation((_query: unknown, args: unknown) =>
      args === "skip" ? undefined : listed,
    );
    await act(async () => root.render(<Handing signedIn />));
    expect(shell.set).toHaveBeenLastCalledWith(listed);
  });

  test("not signed in, or in a browser: nothing asked of the server", async () => {
    desktopApp("on");
    h.useQuery.mockReturnValue(undefined);
    await act(async () => root.render(<Handing signedIn={false} />));
    expect(h.useQuery).toHaveBeenLastCalledWith(expect.anything(), "skip");
    delete window.memocaShell;
    await act(async () => root.render(<Handing signedIn />));
    expect(h.useQuery).toHaveBeenLastCalledWith(expect.anything(), "skip");
  });

  const openBell = async () => {
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="期日の通知"]')!.click();
    });
    // Its state read, as it opens.
    await act(async () => {});
  };
  const deviceSwitch = () => document.querySelector<HTMLButtonElement>("#todo-notify-device");

  test("the bell turns this computer on through the app, and the account's reminders on with it", async () => {
    const shell = desktopApp("off");
    const doc = todo();
    await act(async () =>
      root.render(
        <QuickTips>
          <TodoNotify doc={doc} />
        </QuickTips>,
      ),
    );
    await openBell();
    expect(document.body.textContent).toContain("このパソコンで通知を受け取る");
    expect(deviceSwitch()?.disabled).toBe(false);
    // No key for the browsers' pushes asked for: the app needs none.
    expect(h.query).not.toHaveBeenCalled();

    await act(async () => deviceSwitch()!.click());
    expect(shell.turnOn).toHaveBeenCalledTimes(1);
    expect(deviceSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(doc.getMap<string>(NOTIFY_MAP).get(ON_KEY)).toBe("1");

    await act(async () => deviceSwitch()!.click());
    expect(shell.turnOff).toHaveBeenCalledTimes(1);
    expect(deviceSwitch()?.getAttribute("aria-checked")).toBe("false");
  });

  test("turned on but not allowed by the Mac: on, and told where to allow them", async () => {
    desktopApp("off", "blocked");
    const doc = todo();
    await act(async () =>
      root.render(
        <QuickTips>
          <TodoNotify doc={doc} />
        </QuickTips>,
      ),
    );
    await openBell();
    await act(async () => deviceSwitch()!.click());
    expect(deviceSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("システム設定の「通知」で Memoca を選び");
    expect(doc.getMap<string>(NOTIFY_MAP).get(ON_KEY)).toBe("1");
  });

  test("an app that can show none (a Mac's outside Applications): said so, and the switch off", async () => {
    desktopApp("unsupported");
    await act(async () =>
      root.render(
        <QuickTips>
          <TodoNotify doc={todo()} />
        </QuickTips>,
      ),
    );
    await openBell();
    expect(deviceSwitch()?.disabled).toBe(true);
    expect(document.body.textContent).toContain("「アプリケーション」フォルダーに入れてから");
  });

  test("an app from before its own notifications: they come with its update", async () => {
    window.memocaShell = { platform: "macos" } as unknown as MemocaShell;
    h.query.mockResolvedValue("BPublic");
    await act(async () =>
      root.render(
        <QuickTips>
          <TodoNotify doc={todo()} />
        </QuickTips>,
      ),
    );
    await openBell();
    expect(deviceSwitch()?.disabled).toBe(true);
    expect(document.body.textContent).toContain("アプリが新しい版に更新されると");
  });
});
