import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

const h = vi.hoisted(() => ({ mutation: vi.fn() }));
vi.mock("convex/react", () => ({ useConvex: () => ({ mutation: h.mutation }) }));

import { TodoDuePicker } from "@/components/notes/todo-due-picker";
import { useSendReminders } from "@/components/notes/todo-notify";
import { NONE, NOTIFY_MAP, ON_KEY } from "@/lib/notify/reminders";
import { DUE_MAP, TODO_DUE } from "@/lib/quick/todo-due";
import { ORIGIN, bodyFragment } from "@/lib/sync/ydoc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  h.mutation.mockReset();
  h.mutation.mockResolvedValue({ status: "ok" });
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
});

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
  useSendReminders(doc);
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
    doc.transact(() => doc.getMap<string>(DUE_MAP).set("a", doc.getMap<string>(DUE_MAP).get("a")!), TODO_DUE);
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
      const button = [...document.querySelectorAll("button")].find((each) => each.textContent === name);
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
      [...document.querySelectorAll("button")].find((each) => each.textContent === name)?.getAttribute("aria-pressed");
    expect(pressed("いつもどおり")).toBe("true");

    await press("通知しない");
    expect(onNotify).toHaveBeenLastCalledWith(NONE);
    expect(pressed("通知しない")).toBe("true");

    // A day alone: the account's, but the hours'.
    await press("時刻を選ぶ");
    expect(onNotify).toHaveBeenLastCalledWith(["eve", "morning"]);
    const hour = [...document.querySelectorAll("button")].find((each) => each.textContent === "1 時間前");
    expect(hour?.disabled).toBe(true);
    await press("前日 21:00");
    expect(onNotify).toHaveBeenLastCalledWith(["morning"]);

    await press("いつもどおり");
    expect(onNotify).toHaveBeenLastCalledWith(null);
  });
});
