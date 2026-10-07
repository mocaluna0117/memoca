import "fake-indexeddb/auto";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { DRAFT_DELAY_MS, loadDraft, loadTabs } from "@/lib/quick/draft";
import { SHELL_HIDDEN } from "@/lib/quick/shell";
import { bodyFragment } from "@/lib/sync/ydoc";

const ME = "user-me";

/** The draft of the tab shown, for an account. */
const draftOf = async (userKey: string) => loadDraft(userKey, (await loadTabs(userKey)).active);
/** Each tab's draft text, in order (empty where there is none). */
const tabTexts = async (userKey: string) => {
  const tabs = await loadTabs(userKey);
  return Promise.all(tabs.ids.map(async (id) => (await loadDraft(userKey, id))?.text ?? ""));
};

const h = vi.hoisted(() => ({
  params: new URLSearchParams("window=1"),
  me: { userKey: "user-me", inboxFolderId: "inbox-1" } as {
    userKey: string;
    inboxFolderId: string;
  } | null,
  replace: vi.fn(),
  push: vi.fn(),
  createNote: vi.fn(),
  closed: vi.fn(),
  opened: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  newBuild: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: h.push }),
  useSearchParams: () => h.params,
}));
vi.mock("@/components/providers/sync-provider", () => ({ useSync: () => ({ me: h.me }) }));
vi.mock("@/lib/sync/mutations", () => ({ createNote: h.createNote }));
vi.mock("@/lib/sync/docs", () => ({ acquireDoc: h.acquire, releaseDoc: h.release }));
vi.mock("@/lib/build", () => ({ newBuildOut: h.newBuild }));
vi.mock("@/lib/quick/shell", async (original) => ({
  ...(await original<typeof import("@/lib/quick/shell")>()),
  closeQuickWindow: h.closed,
  openNoteInApp: h.opened,
}));

import { QuickCapture } from "@/components/notes/quick-capture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Lets effects, Dexie and the promises after them run: the tabs, written and
 * read back by a live query, take a few rounds.
 */
const settle = async () => {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    });
  }
};

let root: Root;
let host: HTMLDivElement;
/** The documents saves wrote bodies into, by note. */
let docs: Map<string, Y.Doc>;

const field = () => host.querySelector("textarea")!;
const statuses = () => host.querySelectorAll('[role="status"]');
const status = () => statuses()[0]!.textContent;
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find((found) => found.textContent === name)!;
const bodyOf = (noteId: string) =>
  bodyFragment(docs.get(noteId)!)
    .toArray()
    .flatMap((group) => (group instanceof Y.XmlElement ? group.toArray() : []))
    .map((container) => (container as Y.XmlElement).toArray()[0]!)
    .map((paragraph) => (paragraph as Y.XmlElement).toArray().map(String).join(""));

/** Opens the quick note at this address, as the router would show it. */
async function render(query = "window=1") {
  h.params = new URLSearchParams(query);
  window.history.replaceState(null, "", `/quick?${query}`);
  await act(async () => root.render(<QuickCapture />));
  await settle();
}

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit & { keyCode?: number }, target: EventTarget = field()) {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    // jsdom leaves keyCode at 0 whatever it is given.
    if (init.keyCode) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    target.dispatchEvent(event);
  });
  await settle();
}

async function click(name: string) {
  await act(async () => button(name).click());
  await settle();
}

/** Waits out the pause after which the draft is written. */
async function pause() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS * 2);
  });
  await settle();
}

beforeEach(async () => {
  await resetLocalData();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  h.me = { userKey: ME, inboxFolderId: "inbox-1" };
  let made = 0;
  // Made on this device, as createNote makes one: there to be saved into again.
  h.createNote.mockReset().mockImplementation(async () => {
    const noteId = `note-${(made += 1)}`;
    await db().notes.put({ noteId, deletedAt: null, purged: false } as never);
    return noteId;
  });
  h.closed.mockReset();
  h.opened.mockReset();
  h.replace.mockReset();
  h.push.mockReset();
  docs = new Map();
  h.acquire.mockReset().mockImplementation(async (noteId: string) => {
    if (!docs.has(noteId)) docs.set(noteId, new Y.Doc());
    return docs.get(noteId);
  });
  h.release.mockReset().mockResolvedValue(undefined);
  h.newBuild.mockReset().mockResolvedValue(false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the quick note, saving", () => {
  test("a save lands in Inbox, with no title and all of it in the body", async () => {
    await render();
    await type("買い物\n牛乳\n卵");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledWith({
      folderId: "inbox-1",
      title: "",
      kind: "quick",
    });
    expect(bodyOf("note-1")).toEqual(["買い物", "牛乳", "卵"]);
    expect(h.release).toHaveBeenCalledWith("note-1");
  });

  test("in a window it stays, as it is, and says so, with the note to open", async () => {
    await render();
    await type("窓で保存");
    await key({ key: "Enter", ctrlKey: true });
    expect(field().value).toBe("窓で保存");
    expect(status()).toContain("保存しました");
    await click("メモを開く");
    expect(h.opened).toHaveBeenCalledWith("note-1");
    expect(h.replace).not.toHaveBeenCalled();
  });

  test("as a page it opens the note saved", async () => {
    await render("");
    await type("ページで保存");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.replace).toHaveBeenCalledWith("/app?n=note-1");
  });

  test("⌘ + Enter saves too", async () => {
    await render();
    await type("コマンド");
    await key({ key: "Enter", metaKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
  });

  test("an input method's Enter and Esc are its own, Safari's included", async () => {
    await render();
    await type("変換中");
    await key({ key: "Enter", ctrlKey: true, isComposing: true });
    await key({ key: "Enter", metaKey: true, keyCode: 229 });
    await key({ key: "Escape", isComposing: true }, document);
    await key({ key: "Escape", keyCode: 229 }, document);
    expect(h.createNote).not.toHaveBeenCalled();
    expect(h.closed).not.toHaveBeenCalled();
  });

  test("nothing but blanks is not saved", async () => {
    await render();
    await type("  \n ");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).not.toHaveBeenCalled();
  });

  test("saved, it is kept as it is, as what it was saved as; saved again, into the same note", async () => {
    await render();
    await type("すぐ保存");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    await pause();
    expect(await draftOf(ME)).toMatchObject({ text: "すぐ保存", saved: { noteId: "note-1", text: "すぐ保存" } });
    // Nothing new to save: the button says so.
    expect(button("保存").disabled).toBe(true);

    await type("すぐ保存\n書き足し");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    expect(bodyOf("note-1")).toEqual(["すぐ保存", "書き足し"]);
    expect(field().value).toBe("すぐ保存\n書き足し");
  });

  test("saved again after its note was trashed, into a new one", async () => {
    await render();
    await type("一度目");
    await key({ key: "Enter", ctrlKey: true });
    await db().notes.update("note-1", { deletedAt: 1 });
    await type("二度目");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledTimes(2);
    expect(bodyOf("note-2")).toEqual(["二度目"]);
  });

  test("a save that fails says so, and keeps the text and its draft", async () => {
    h.createNote.mockRejectedValue(new Error("quota"));
    await render();
    await type("失敗する");
    await key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("保存できませんでした");
    expect(field().value).toBe("失敗する");
    expect(field().readOnly).toBe(false);
    await pause();
    expect((await draftOf(ME))?.text).toBe("失敗する");
  });

  test("a save whose body could not be written finishes the same note when tried again", async () => {
    h.acquire.mockRejectedValueOnce(new Error("idb"));
    await render();
    await type("一行目\n本文");
    await key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("保存できませんでした");

    await type("直した一行目\n本文\n続き");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    expect(bodyOf("note-1")).toEqual(["直した一行目", "本文", "続き"]);
    expect(status()).toContain("保存しました");
  });

  test("a body half written by a save that failed is written over, not added to", async () => {
    h.release.mockRejectedValueOnce(new Error("idb"));
    await render();
    await type("一行目\n二行目");
    await key({ key: "Enter", ctrlKey: true });
    expect(status()).toContain("保存できませんでした");

    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    expect(bodyOf("note-1")).toEqual(["一行目", "二行目"]);
  });

  test("while a save is under way the text is not changed under it", async () => {
    let made!: (noteId: string) => void;
    h.createNote.mockImplementation(() => new Promise((resolve) => (made = resolve)));
    await render();
    await type("保存中");
    await key({ key: "Enter", ctrlKey: true });
    expect(field().readOnly).toBe(true);
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    await act(async () => made("note-1"));
    await settle();
    expect(field().readOnly).toBe(false);
  });
});

describe("the quick note's window, closing", () => {
  test("Esc writes the draft before the window goes", async () => {
    await render();
    // Read as the window goes: the draft must already be there, not left to a timer.
    let atClose: Promise<unknown> | undefined;
    h.closed.mockImplementation(() => {
      atClose = draftOf(ME);
    });
    await type("閉じる前");
    await key({ key: "Escape" }, document);
    expect(h.closed).toHaveBeenCalledOnce();
    expect(await atClose).toMatchObject({ text: "閉じる前" });
  });

  test("Esc does not put the window away until the draft is on the device", async () => {
    await render();
    await type("閉じる前");
    const table = db().meta;
    const put = table.put.bind(table);
    let written!: () => void;
    vi.spyOn(table, "put").mockImplementation(
      ((row: unknown) =>
        new Promise((resolve) => (written = () => resolve(put(row as never))))) as never,
    );
    await key({ key: "Escape" }, document);
    expect(h.closed).not.toHaveBeenCalled();
    await act(async () => written());
    await settle();
    expect(h.closed).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  test("Esc waits for a save under way, and the window shown again does not still say saved", async () => {
    let made!: (noteId: string) => void;
    h.createNote.mockImplementation(() => new Promise((resolve) => (made = resolve)));
    await render();
    await type("保存してから閉じる");
    await key({ key: "Enter", ctrlKey: true });
    await key({ key: "Escape" }, document);
    expect(h.closed).not.toHaveBeenCalled();

    await act(async () => made("note-1"));
    await settle();
    expect(h.closed).toHaveBeenCalledOnce();
    expect(await draftOf(ME)).toMatchObject({ saved: { noteId: "note-1" } });
    expect(status()).toBe("");
  });

  test("the window brought forward is ready to type into", async () => {
    await render();
    field().blur();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).toBe(field());
  });

  test("a page has no Esc to close it", async () => {
    await render("");
    await type("ページ");
    await key({ key: "Escape" }, document);
    expect(h.closed).not.toHaveBeenCalled();
  });
});

describe("the quick note's window, opening Memoca", () => {
  const openApp = () => host.querySelector<HTMLButtonElement>('button[aria-label="Memoca を開く"]');

  afterEach(() => {
    delete window.memocaShell;
  });

  test("a shell that can bring out Memoca's own window has the button, which keeps the draft first", async () => {
    let atShow: Promise<unknown> | undefined;
    const showApp = vi.fn(() => {
      atShow = draftOf(ME);
    });
    window.memocaShell = { hide() {}, openExternal() {}, showApp, platform: "macos" };
    await render();
    await type("書きかけ");
    await act(async () => openApp()!.click());
    await settle();
    expect(showApp).toHaveBeenCalledOnce();
    expect(await atShow).toMatchObject({ text: "書きかけ" });
  });

  test("an older shell, or a browser's window, has none", async () => {
    window.memocaShell = { hide() {}, openExternal() {}, platform: "macos" };
    await render();
    expect(openApp()).toBeNull();
    delete window.memocaShell;
    await act(async () => root.render(<QuickCapture key="again" />));
    await settle();
    expect(openApp()).toBeNull();
  });
});

describe("the quick note's window, put away by the desktop shell", () => {
  /** The shell puts the window away (desktop/src-tauri/src/window.rs), keeping it loaded. */
  const putAway = async () => {
    await act(async () => {
      window.dispatchEvent(new Event(SHELL_HIDDEN));
    });
    await settle();
  };

  test("keeps what is written, and then loads a new version of the site out of sight", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    // Asked only once the draft is on the device.
    h.newBuild.mockImplementation(async () => {
      expect(await draftOf(ME)).toMatchObject({ text: "書きかけ" });
      return true;
    });
    await render();
    await type("書きかけ");
    await putAway();
    expect(h.newBuild).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  test("put away while a save is under way, waits for it before loading anew", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    h.newBuild.mockResolvedValue(true);
    let made!: (id: string) => void;
    h.createNote.mockImplementation(() => new Promise((resolve) => (made = resolve)));
    await render();
    await type("保存中");
    await key({ key: "Enter", metaKey: true });
    await putAway();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => made("note-1"));
    await settle();
    expect(reload).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  test("brought out again while the server is asked, is not loaded anew under the person typing", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    h.newBuild.mockResolvedValue(true);
    await render();
    await putAway();
    expect(h.newBuild).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("with no new version, is left as it is", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await render();
    await type("書きかけ");
    await putAway();
    expect(h.newBuild).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(field().value).toBe("書きかけ");
  });

  test("as a page, is not the shell's to put away", async () => {
    await render("");
    await putAway();
    expect(h.newBuild).not.toHaveBeenCalled();
  });

  test("the window is moved by its header, which a page has not", async () => {
    await render();
    const header = host.querySelector("header")!;
    expect(header.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(header.querySelector("h1")!.hasAttribute("data-tauri-drag-region")).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render("");
    expect(host.querySelector("header")!.hasAttribute("data-tauri-drag-region")).toBe(false);
  });
});

describe("the quick note's draft, coming back", () => {
  test("one left by a version with no tabs comes back in the first tab", async () => {
    await setMeta(META.quickDraft, { text: "下書き", updatedAt: 0, userKey: ME });
    await render();
    expect(field().value).toBe("下書き");
    expect(status()).toBe("");
    expect(await tabTexts(ME)).toEqual(["下書き"]);
  });

  test("what is shared goes into a tab of its own, the draft left as it is", async () => {
    await setMeta(META.quickDraft, { text: "下書き", updatedAt: 0, userKey: ME });
    await render("window=1&text=共有");
    expect(field().value).toBe("共有");
    await pause();
    expect(await tabTexts(ME)).toEqual(["下書き", "共有"]);
  });

  test("closed straight after a share, both are kept", async () => {
    await setMeta(META.quickDraft, { text: "下書き", updatedAt: 0, userKey: ME });
    await render("window=1&text=共有");
    await key({ key: "Escape" }, document);
    expect(await tabTexts(ME)).toEqual(["下書き", "共有"]);
  });

  test("a draft holding what is shared is not given it again", async () => {
    await setMeta(META.quickDraft, { text: "共有", updatedAt: 0, userKey: ME });
    await render("window=1&text=共有");
    expect(field().value).toBe("共有");
    expect((await loadTabs(ME)).ids).toHaveLength(1);
  });

  test("what was shared leaves the address, so loading it again does not add it twice", async () => {
    await render("window=1&text=共有&title=題");
    expect(field().value).toBe("題\n共有");
    expect(window.location.search).toBe("?window=1");
  });

  test("another account's draft is not shown, and one signing in on the device starts afresh", async () => {
    await setMeta(META.quickDraft, { text: "他人の下書き", updatedAt: 0, userKey: "user-other" });
    await render();
    expect(field().value).toBe("");

    await type("私の");
    h.me = { userKey: "user-next", inboxFolderId: "inbox-2" };
    await act(async () => root.render(<QuickCapture />));
    await settle();
    expect(field().value).toBe("");
    // What the last one had typed is kept as its draft, for it alone, and
    // the next one's empty field, written in its turn, does not forget it.
    await pause();
    expect(await draftOf(ME)).toMatchObject({ text: "私の" });
    expect(await draftOf("user-next")).toBeNull();
  });
});

describe("the quick note's tabs", () => {
  const tabs = () => Array.from(host.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
  const selected = () => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  const labelled = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  async function press(element: HTMLElement) {
    await act(async () => element.click());
    await settle();
  }
  const tab = (name: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((found) => found.textContent === name)!;
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const inDialog = (name: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find(
      (found) => found.textContent === name,
    )!;

  test("each its own draft, named by its first line, kept as tabs are switched", async () => {
    await render();
    await type("一つ目\n本文");
    expect(tabs()).toEqual(["一つ目"]);
    await press(labelled("新しいタブ"));
    expect(tabs()).toEqual(["一つ目", "新しいメモ"]);
    expect(field().value).toBe("");
    await type("二つ目");
    await press(tab("一つ目"));
    expect(field().value).toBe("一つ目\n本文");
    expect(selected()).toBe("一つ目");
    await pause();
    expect(await tabTexts(ME)).toEqual(["一つ目\n本文", "二つ目"]);
  });

  test("a tab saved stays as it is; closed then, nothing is asked", async () => {
    await render();
    await type("一つ目");
    await press(labelled("新しいタブ"));
    await type("二つ目");
    await click("保存");
    expect(h.createNote).toHaveBeenCalledTimes(1);
    expect(tabs()).toEqual(["一つ目", "二つ目"]);
    expect(field().value).toBe("二つ目");
    expect(status()).toContain("保存しました");

    // Its own still saved when shown again.
    await press(tab("一つ目"));
    await press(tab("二つ目"));
    expect(button("保存").disabled).toBe(true);
    await press(labelled("二つ目 のタブを閉じる"));
    expect(dialog()).toBeNull();
    expect(tabs()).toEqual(["一つ目"]);
  });

  test("closing a tab with something in it asks first: kept, let go of, or saved", async () => {
    await render();
    await type("一つ目");
    await press(labelled("新しいタブ"));
    await type("二つ目");

    await press(labelled("二つ目 のタブを閉じる"));
    expect(dialog()?.textContent).toContain("「二つ目」には、保存していない内容があります");
    await press(inDialog("キャンセル"));
    expect(dialog()).toBeNull();
    expect(tabs()).toEqual(["一つ目", "二つ目"]);

    await press(labelled("二つ目 のタブを閉じる"));
    await press(inDialog("保存せずに閉じる"));
    expect(tabs()).toEqual(["一つ目"]);
    expect(h.createNote).not.toHaveBeenCalled();
    await pause();
    expect(await tabTexts(ME)).toEqual(["一つ目"]);

    await press(labelled("新しいタブ"));
    await type("三つ目");
    await press(labelled("三つ目 のタブを閉じる"));
    await press(inDialog("保存して閉じる"));
    expect(h.createNote).toHaveBeenCalledTimes(1);
    expect(tabs()).toEqual(["一つ目"]);
    expect(bodyOf("note-1")).toEqual(["三つ目"]);
  });

  test("an empty tab closes at once; the only tab has no ×", async () => {
    await render();
    expect(host.querySelector('button[aria-label$="のタブを閉じる"]')).toBeNull();
    await press(labelled("新しいタブ"));
    await press(labelled("新しいメモ のタブを閉じる"));
    expect(dialog()).toBeNull();
    expect(tabs()).toEqual(["新しいメモ"]);
  });

  test("Esc closes the dialog, not the window", async () => {
    await render();
    await type("一つ目");
    await press(labelled("新しいタブ"));
    await type("二つ目");
    await press(labelled("二つ目 のタブを閉じる"));
    await key({ key: "Escape" }, document.activeElement ?? document);
    expect(h.closed).not.toHaveBeenCalled();
  });
});

describe("the quick note's status line", () => {
  test("is in the page from the start, once, in a window and as a page", async () => {
    await render();
    expect(statuses()).toHaveLength(1);
    expect(status()).toBe("");
    await act(async () => root.unmount());
    root = createRoot(host);
    await render("");
    expect(statuses()).toHaveLength(1);
  });

  test("in a window, takes the place of the keys while it says something", async () => {
    await render();
    expect(host.textContent).toContain("Enter で保存");
    await type("保存");
    await key({ key: "Enter", ctrlKey: true });
    expect(host.textContent).not.toContain("Enter で保存");
    await type("次");
    expect(host.textContent).toContain("Enter で保存");
  });
});

describe("the quick note as a page on a phone", () => {
  type Viewport = EventTarget & { height: number; offsetTop: number; scale: number };
  let viewport: Viewport;

  beforeEach(() => {
    viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 800,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  });

  /** A keyboard comes up, or goes, and iOS pans what is seen to the caret. */
  const move = (change: Partial<Viewport>) =>
    act(async () => {
      Object.assign(viewport, change);
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
    });

  test("keeps the line tapped on in sight as iOS pans to it, and leaves the text be as it pans back", async () => {
    await render("");
    await type("行\n".repeat(200));
    field().focus();
    field().scrollTop = 300;
    await move({ height: 420, offsetTop: 270 });
    expect(field().scrollTop).toBe(570);
    await move({ height: 800, offsetTop: 0 });
    expect(field().scrollTop).toBe(570);
  });

  test("does not scroll a field that does not have the focus", async () => {
    await render("");
    await type("行\n".repeat(200));
    field().blur();
    field().scrollTop = 300;
    await move({ height: 420, offsetTop: 270 });
    expect(field().scrollTop).toBe(300);
  });

  test("writes at 16px at every width, which iOS does not zoom in on", async () => {
    await render("");
    expect(field().className).toContain("md:text-base");
    expect(field().className).not.toContain("md:text-sm");
  });

  test("clears the home indicator, but not with a keyboard over it", async () => {
    await render("");
    expect(field().style.paddingBottom).toContain("safe-area-inset-bottom");
    await move({ height: 420 });
    expect(field().style.paddingBottom).toBe("");
  });
});
