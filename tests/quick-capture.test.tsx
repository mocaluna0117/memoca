import "fake-indexeddb/auto";
import type React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { DRAFT_DELAY_MS, keepDraft, loadTabs } from "@/lib/quick/draft";
import { imageUrls } from "@/lib/quick/body";
import { SHELL_HIDDEN } from "@/lib/quick/shell";
import { readSaved } from "@/lib/quick/tabs";
import { bodyFragment, extractText } from "@/lib/sync/ydoc";

const ME = "user-me";

/**
 * What the tab shown holds, for an account: its note's text, its images'
 * references, and what it was saved as (each tab a note of the account's,
 * lib/quick/tabs). Null for a tab whose note was never written into.
 */
const draftOf = async (userKey: string) => {
  const doc = docs.get((await loadTabs(userKey)).active);
  return doc ? { text: extractText(doc), images: imageUrls(doc), saved: readSaved(doc) } : null;
};
/** Each tab's text, in order (empty where there is none). */
const tabTexts = async (userKey: string) => {
  const tabs = await loadTabs(userKey);
  return tabs.ids.filter((id) => id !== "todo").map((id) => (docs.get(id) ? extractText(docs.get(id)!) : ""));
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
  prepare: vi.fn(),
  stage: vi.fn(),
  move: vi.fn(),
  trash: vi.fn(),
  makeTab: vi.fn(),
  flush: vi.fn(),
  /** The document of the tab shown, as its editor has it. */
  doc: null as unknown as import("yjs").Doc,
  /** How many image blocks a paste has made, for each its own id. */
  made: 0,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: h.push }),
  useSearchParams: () => h.params,
}));
vi.mock("@/components/providers/sync-provider", () => ({
  useSync: () => ({ me: h.me }),
  useStorageUsage: () => h.me,
  // For moving lines into the Todo (lib/quick/todo-move).
  useSyncStatusStore: () => ({ get: () => ({ lastSyncAt: null, catchingUp: false }) }),
  useSyncEngine: () => () => null,
}));
vi.mock("@/lib/sync/mutations", () => ({ createNote: h.createNote, moveNote: h.move, setNoteTrashed: h.trash }));
vi.mock("@/lib/quick/tabs", async (original) => ({
  ...(await original<typeof import("@/lib/quick/tabs")>()),
  makeTabNote: h.makeTab,
}));
// All of a tab's note here at once: no server to wait for.
vi.mock("@/lib/quick/todo", () => ({ wholeBody: async () => {} }));
// In a browser, the desktop app's reminders are not followed (useShellReminders): "skip".
vi.mock("convex/react", () => ({ useConvex: () => ({}), useQuery: () => undefined }));
// The editor, as a field of lines: each a paragraph of the tab's document,
// with ids that follow from where it is, so that the same lines say the same.
// Images, as the editor puts them: a block for each file pasted, shown
// loading while the quick note makes it ready, given its reference by the
// quick note once it is, and taken out again if it is turned away (as
// settleRefusedBlock does). Kept after the lines as they are typed.
vi.mock("@/components/notes/quick-editor", async () => {
  const React = await import("react");
  const { appendParagraphs, blockOf } = await import("@/lib/quick/body");
  const { bodyFragment: fragmentOf } = await import("@/lib/sync/ydoc");
  const isImage = (container: unknown) =>
    ((container as Y.XmlElement).toArray()[0] as Y.XmlElement | undefined)?.nodeName === "image";
  const containersOf = (doc: Y.Doc) =>
    ((fragmentOf(doc).get(0) as Y.XmlElement | undefined)?.toArray() ?? []) as Y.XmlElement[];
  const linesOf = (doc: Y.Doc) =>
    containersOf(doc)
      .filter((container) => !isImage(container))
      .map((container) => (container.toArray()[0] as Y.XmlElement).toArray().map(String).join(""));
  const write = (doc: Y.Doc, value: string) =>
    doc.transact(() => {
      const fragment = fragmentOf(doc);
      const images = containersOf(doc).filter(isImage);
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      appendParagraphs(doc, value.split("\n"));
      const group = fragment.get(0) as Y.XmlElement;
      group.toArray().forEach((container, at) => {
        (container as Y.XmlElement).setAttribute("id", `line-${at}`);
      });
      group.insert(group.length, images);
    });
  const addImage = (doc: Y.Doc, id: string, name: string) =>
    doc.transact(() => {
      if (fragmentOf(doc).length === 0) appendParagraphs(doc, [""]);
      const group = fragmentOf(doc).get(0) as Y.XmlElement;
      const container = new Y.XmlElement("blockContainer");
      group.insert(group.length, [container]);
      container.setAttribute("id", id);
      const image = new Y.XmlElement("image");
      container.insert(0, [image]);
      image.setAttribute("name", name);
      image.setAttribute("url", "");
    });
  const takeOut = (doc: Y.Doc, id: string) => {
    const container = blockOf(doc, id);
    const group = container?.parent;
    if (container && group instanceof Y.XmlElement) group.delete(group.toArray().indexOf(container), 1);
  };
  function QuickEditor({
    doc,
    handle,
    onSave,
    images,
    autoFocus,
  }: {
    doc: Y.Doc;
    autoFocus?: boolean;
    handle: React.Ref<{ focus: () => void; focused: () => boolean }>;
    onSave: () => void;
    images: { begin: () => void; prepare: (file: File, blockId?: string) => Promise<string> };
  }) {
    h.doc = doc;
    const field = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(handle, () => ({
      focus: () => field.current?.focus(),
      focused: () => document.activeElement === field.current,
    }));
    return (
      <textarea
        ref={field}
        aria-label="即席メモ"
        autoFocus={autoFocus}
        defaultValue={linesOf(doc).join("\n")}
        onChange={(event) => write(doc, event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSave();
          }
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          images.begin();
          for (const file of files) {
            const id = `image-${(h.made += 1)}`;
            addImage(doc, id, file.name);
            images.prepare(file, id).catch(() => takeOut(doc, id));
          }
        }}
      />
    );
  }
  return { QuickEditor };
});
// The Todo's tab, as a stand-in: what it is is tested in the browser (e2e/quick-todo.spec.ts).
vi.mock("@/components/notes/quick-todo", () => ({
  TodoCapture: ({ strip }: { strip: React.ReactNode }) => (
    <main>
      {strip}
      <p data-todo-stand-in="">Todo</p>
    </main>
  ),
}));
// The folders to choose from, as buttons: which may be chosen is the quick
// note's own rule (tests/quick-folder.test.ts).
vi.mock("@/components/folders/folder-picker", () => ({
  FolderPicker: ({
    open,
    onPick,
    onOpenChange,
  }: {
    open: boolean;
    onPick: (id: string | null) => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog">
        {["work", "inbox-1"].map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              onPick(id);
              onOpenChange(false);
            }}
          >
            {`選ぶ:${id}`}
          </button>
        ))}
      </div>
    ) : null,
}));
vi.mock("@/lib/sync/docs", () => ({ acquireDoc: h.acquire, releaseDoc: h.release, flushDoc: h.flush }));
vi.mock("@/lib/build", () => ({ newBuildOut: h.newBuild }));
vi.mock("@/lib/quick/shell", async (original) => ({
  ...(await original<typeof import("@/lib/quick/shell")>()),
  closeQuickWindow: h.closed,
  openNoteInApp: h.opened,
}));
vi.mock("@/lib/media/attachments", async (original) => ({
  ...(await original<typeof import("@/lib/media/attachments")>()),
  prepareUpload: h.prepare,
  stageUpload: h.stage,
  resolveAttachment: async () => null,
}));

import { QuickCapture, TAB_NAME_DELAY_MS } from "@/components/notes/quick-capture";
import { QuotaError } from "@/lib/media/attachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no object URLs; each thumbnail is shown by one.
let nextUrl = 0;
URL.createObjectURL = () => `blob:test/${nextUrl++}`;
URL.revokeObjectURL = () => {};

/**
 * Lets effects, Dexie and the promises after them run: the tabs, written and
 * read back by a live query, take a few rounds.
 */
const settle = async () => {
  // A tab's note made, its body read and the editor shown on it: more rounds.
  for (let round = 0; round < 8; round += 1) {
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
    .filter((block) => (block as Y.XmlElement).nodeName !== "image")
    .map((paragraph) => (paragraph as Y.XmlElement).toArray().map(String).join(""));
/** The kinds of the blocks a save wrote. */
const kindsOf = (noteId: string) =>
  bodyFragment(docs.get(noteId)!)
    .toArray()
    .flatMap((group) => (group instanceof Y.XmlElement ? group.toArray() : []))
    .map((container) => ((container as Y.XmlElement).toArray()[0] as Y.XmlElement).nodeName);

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
  // The tabs are told what is typed a moment later.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TAB_NAME_DELAY_MS);
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
    if (!docs.has(noteId)) {
      const doc = new Y.Doc();
      docs.set(noteId, doc);
      // A tab's note's first line, for the tabs, as the documents write it.
      if (noteId.startsWith("quick-tab-")) {
        doc.on("update", () => {
          const preview = extractText(doc).split("\n").find((line) => line.trim() !== "") ?? "";
          void db().notes.update(noteId, { preview });
        });
      }
    }
    return docs.get(noteId);
  });
  h.release.mockReset().mockResolvedValue(undefined);
  h.flush.mockReset().mockResolvedValue(undefined);
  // A tab's note, as makeTabNote makes one: hidden, synced, here at once.
  h.makeTab.mockReset().mockImplementation(async (noteId: string) => {
    await db().notes.put({ noteId, deletedAt: null, purged: false, preview: "", lastUpdateSeq: 0, snapshotSeq: 0 } as never);
  });
  // Into the trash, as a tab closed puts its note: out of the tabs everywhere.
  h.trash.mockReset().mockImplementation(async (noteId: string, trashed: boolean) => {
    await db().notes.update(noteId, { deletedAt: trashed ? Date.now() : null });
  });
  h.newBuild.mockReset().mockResolvedValue(false);
  // Made ready at once, as it came: the tests of that have it wait.
  h.prepare.mockReset().mockImplementation(async (file: File) => ({
    blob: file,
    mime: file.type,
    width: 1,
    height: 1,
  }));
  h.stage.mockReset().mockResolvedValue("memoca://att-1");
  h.move.mockReset().mockResolvedValue(undefined);
  await db().folders.bulkPut([
    { folderId: "inbox-1", parentId: null, name: "Inbox", system: "inbox", locked: false, deletedAt: null, purged: false, sortKey: "a" },
    { folderId: "work", parentId: null, name: "仕事", system: null, locked: false, deletedAt: null, purged: false, sortKey: "b" },
    { folderId: "vault", parentId: null, name: "金庫", system: null, locked: true, deletedAt: null, purged: false, sortKey: "c" },
  ] as never);
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
    expect(await draftOf(ME)).toMatchObject({
      text: "すぐ保存",
      saved: { noteId: "note-1", text: "すぐ保存" },
    });
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
    // The note saved into, not the tab's own.
    const acquire = h.acquire.getMockImplementation()!;
    let failed = false;
    h.acquire.mockImplementation(async (noteId: string) => {
      if (noteId === "note-1" && !failed) {
        failed = true;
        throw new Error("idb");
      }
      return acquire(noteId);
    });
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

  test("while a save is under way, another ⌘ + Enter is not another save", async () => {
    let made!: (noteId: string) => void;
    h.createNote.mockImplementation(() => new Promise((resolve) => (made = resolve)));
    await render();
    await type("保存中");
    await key({ key: "Enter", ctrlKey: true });
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    await act(async () => made("note-1"));
    await settle();
    expect(status()).toContain("保存しました");
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

  test("Esc does not put the window away until what is written is on the device", async () => {
    await render();
    await type("閉じる前");
    // The tab's note written to the device: held back, to see the window wait for it.
    let written!: () => void;
    h.flush.mockImplementation(() => new Promise<void>((resolve) => (written = resolve)));
    await key({ key: "Escape" }, document);
    expect(h.closed).not.toHaveBeenCalled();
    await act(async () => written());
    await settle();
    expect(h.closed).toHaveBeenCalledOnce();
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
    // In its tab's note, the account's: sent as any note is, not the device's.
    expect(await draftOf(ME)).toMatchObject({ text: "私の" });
    // Another signing in on the device: the device emptied first, as signing
    // in does, and its quick note starts afresh.
    await act(async () => root.unmount());
    await resetLocalData();
    root = createRoot(host);
    h.me = { userKey: "user-next", inboxFolderId: "inbox-2" };
    await render();
    expect(field().value).toBe("");
    expect((await draftOf("user-next"))?.text ?? "").toBe("");
  });
});

describe("the quick note's tabs", () => {
  const tabs = () =>
    Array.from(host.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
  const selected = () => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  const labelled = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  async function press(element: HTMLElement) {
    await act(async () => element.click());
    await settle();
  }
  const tab = (name: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (found) => found.textContent === name,
    )!;
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

describe("the quick note's images", () => {
  type Prepared = { blob: Blob; mime: string; width: number; height: number };
  /** The making ready of the image last pasted, finished by hand. */
  let making: { resolve: (prepared: Prepared) => void; reject: (error: unknown) => void };
  const READY: Prepared = { blob: new Blob(["ready"]), mime: "image/webp", width: 40, height: 30 };
  const png = (name = "写真.png") => new File([new Uint8Array(4)], name, { type: "image/png" });
  /** The image blocks of the tab shown, however far in: their names, and whether each has its image yet. */
  const blocks = () => {
    const found: { name: string; shown: boolean }[] = [];
    const walk = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "image") {
          found.push({ name: String(child.getAttribute("name")), shown: Boolean(child.getAttribute("url")) });
        } else walk(child);
      }
    };
    walk(bodyFragment(h.doc));
    return found;
  };
  /** Those shown with their images. */
  const thumbs = () => blocks().filter((block) => block.shown);
  /** The first one still being made ready, shown loading. */
  const busy = () => blocks().find((block) => !block.shown) ?? null;
  /** Takes the block of an image out, as a key would. */
  const takeOut = async (name: string) => {
    await act(async () => {
      const group = bodyFragment(h.doc).get(0) as Y.XmlElement;
      const at = group
        .toArray()
        .findIndex((container) => ((container as Y.XmlElement).get(0) as Y.XmlElement).getAttribute("name") === name);
      group.delete(at, 1);
    });
    await settle();
  };
  const newTab = () => host.querySelector<HTMLButtonElement>('button[aria-label="新しいタブ"]')!;
  const inDialog = (name: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find(
      (found) => found.textContent === name,
    )!;
  /** The image blocks a save wrote, by their reference and name. */
  const imagesOf = (noteId: string) =>
    bodyFragment(docs.get(noteId)!)
      .toArray()
      .flatMap((group) => (group instanceof Y.XmlElement ? group.toArray() : []))
      .map((container) => (container as Y.XmlElement).toArray()[0] as Y.XmlElement)
      .filter((block) => block.nodeName === "image")
      .map((image) => ({ url: image.getAttribute("url"), name: image.getAttribute("name") }));

  /** Pastes files into the field, as a browser does. */
  async function paste(...files: File[]) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files, types: ["Files"], getData: () => "" },
    });
    await act(async () => {
      field().dispatchEvent(event);
    });
    await settle();
  }
  /** The making ready ends, one way or the other. */
  async function finish(outcome: () => void) {
    await act(async () => outcome());
    await settle();
  }

  beforeEach(() => {
    h.prepare.mockImplementation(
      () => new Promise<Prepared>((resolve, reject) => (making = { resolve, reject })),
    );
  });

  afterEach(() => {
    delete window.memocaShell;
  });

  test("a draft's images from before they went where they were pasted (a strip of them) come back after its lines", async () => {
    // A draft as the strip left it: its text, and its images apart.
    const tab = (await loadTabs(ME)).active;
    const kept = keepDraft(ME, tab);
    kept.update({ text: "前の下書き" });
    kept.images([{ key: "old-1", name: "前の写真.png", blob: new Blob(["old"]), mime: "image/webp", width: 4, height: 3 }]);
    kept.release();
    await kept.flush(true);
    kept.dispose();
    await render();
    expect(field().value).toBe("前の下書き");
    expect(blocks()).toEqual([{ name: "前の写真.png", shown: true }]);
    // Sent up as the tab's note's file, as one pasted now is.
    expect(h.stage).toHaveBeenCalledOnce();
    expect(h.stage.mock.calls[0]![0]).toMatchObject({ noteId: expect.stringMatching(/^quick-tab-/) });
    expect((await draftOf(ME))?.images).toEqual(["memoca://att-1"]);
  });

  test("one pasted is shown at once, and is in the draft only once it is ready", async () => {
    await render();
    await type("写真つき");
    await paste(png());
    expect(h.prepare).toHaveBeenCalledOnce();
    // Where it was put, loading.
    expect(busy()?.name).toBe("写真.png");
    await pause();
    expect((await draftOf(ME))?.images ?? []).toEqual([]);
    expect(h.stage).not.toHaveBeenCalled();
    await finish(() => making.resolve(READY));
    expect(busy()).toBeNull();
    expect(thumbs()).toHaveLength(1);
    // Sent up, as it was made ready, as the tab's note's file.
    expect(h.stage).toHaveBeenCalledOnce();
    expect(h.stage.mock.calls[0]![0]).toMatchObject({
      noteId: (await loadTabs(ME)).active,
      prepared: { mime: "image/webp", width: 40, height: 30 },
    });
    expect((await draftOf(ME))?.images).toEqual(["memoca://att-1"]);
  });

  test("⌘ + Enter while one is being made ready saves once it is, with the image, once", async () => {
    await render();
    await type("本文");
    await paste(png());
    await key({ key: "Enter", metaKey: true });
    await key({ key: "Enter", metaKey: true });
    expect(h.createNote).not.toHaveBeenCalled();
    await finish(() => making.resolve(READY));
    expect(h.createNote).toHaveBeenCalledOnce();
    // Sent once, as the tab's note's file; the note saved uses it too.
    expect(h.stage).toHaveBeenCalledOnce();
    expect(h.stage.mock.calls[0]![0]).toMatchObject({ noteId: expect.stringMatching(/^quick-tab-/) });
    expect(bodyOf("note-1")).toEqual(["本文"]);
    expect(kindsOf("note-1")).toEqual(["paragraph", "image"]);
    expect(imagesOf("note-1")).toEqual([{ url: "memoca://att-1", name: "写真.png" }]);
    expect(status()).toContain("保存しました");
  });

  test("one turned away goes, and the status line says why", async () => {
    await render();
    await paste(png());
    expect(busy()).not.toBeNull();
    await finish(() => making.reject(new QuotaError("quotaExceeded")));
    expect(thumbs()).toHaveLength(0);
    expect(status()).toContain("保存できる容量を超えました");
    expect(button("保存").disabled).toBe(true);
  });

  test("one taken out before it is ready stays out", async () => {
    await render();
    await paste(png());
    await takeOut("写真.png");
    expect(blocks()).toHaveLength(0);
    await finish(() => making.resolve(READY));
    expect(thumbs()).toHaveLength(0);
    expect(status()).toBe("");
    await pause();
    expect((await draftOf(ME))?.images ?? []).toEqual([]);
  });

  test("Esc, in a window of a page's, waits for one being made ready, so that the draft keeps it", async () => {
    await render();
    await paste(png());
    await key({ key: "Escape" }, document);
    expect(h.closed).not.toHaveBeenCalled();
    await finish(() => making.resolve(READY));
    expect(h.closed).toHaveBeenCalledOnce();
    expect((await draftOf(ME))?.images).toHaveLength(1);
  });

  test("in the desktop shell, Esc puts the window away at once; the shell, putting it away, waits for the image", async () => {
    window.memocaShell = { hide() {}, openExternal() {}, platform: "macos" };
    await render();
    await paste(png());
    await key({ key: "Escape" }, document);
    expect(h.closed).toHaveBeenCalledOnce();
    // Hidden, the window is told so by the shell (desktop/src-tauri/src/window.rs).
    await act(async () => {
      window.dispatchEvent(new Event(SHELL_HIDDEN));
    });
    await settle();
    expect(h.newBuild).not.toHaveBeenCalled();
    await finish(() => making.resolve(READY));
    expect(h.newBuild).toHaveBeenCalledOnce();
    expect((await draftOf(ME))?.images).toHaveLength(1);
  });

  test("one turned away while Esc waits for it is still said as the window comes back", async () => {
    await render();
    await paste(png());
    await key({ key: "Escape" }, document);
    expect(h.closed).not.toHaveBeenCalled();
    await finish(() => making.reject(new QuotaError("quotaExceeded")));
    expect(h.closed).toHaveBeenCalledOnce();
    expect(status()).toContain("保存できる容量を超えました");
  });

  test("a file that is not an image is turned away at once", async () => {
    await render();
    await paste(new File(["text"], "memo.txt", { type: "text/plain" }));
    expect(h.prepare).not.toHaveBeenCalled();
    expect(thumbs()).toHaveLength(0);
    expect(status()).toContain("文字と画像だけ");
  });

  test("one turned away while ⌘ + Enter waits for it is said, and nothing is saved over that", async () => {
    await render();
    await type("本文");
    await paste(png());
    await key({ key: "Enter", metaKey: true });
    await finish(() => making.reject(new QuotaError("quotaExceeded")));
    expect(h.createNote).not.toHaveBeenCalled();
    expect(thumbs()).toHaveLength(0);
    expect(status()).toContain("保存できる容量を超えました");
    expect(field().value).toBe("本文");
    expect(field().readOnly).toBe(false);
  });

  test("the limit, said of a batch, is still said once the first of them is ready", async () => {
    await render();
    await paste(...Array.from({ length: 11 }, (_, at) => png(`${at + 1}.png`)));
    expect(blocks()).toHaveLength(10);
    expect(status()).toContain("10 枚まで");
    // Made ready one after another, each shown loading meanwhile.
    expect(h.prepare).toHaveBeenCalledOnce();
    await finish(() => making.resolve(READY));
    expect(status()).toContain("10 枚まで");
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(blocks().filter((block) => !block.shown)).toHaveLength(9);
  });

  test("a file that is not an image, pasted with a photo, is still said once the photo is ready", async () => {
    await render();
    await paste(png(), new File(["text"], "memo.txt", { type: "text/plain" }));
    expect(status()).toContain("文字と画像だけ");
    await finish(() => making.resolve(READY));
    expect(busy()).toBeNull();
    expect(status()).toContain("文字と画像だけ");
    // The next batch says its own.
    await paste(png("次.png"));
    expect(status()).toBe("");
  });

  test("one still being made ready as another tab is shown goes into the draft of the tab it was pasted in", async () => {
    await render();
    const first = (await loadTabs(ME)).active;
    await paste(png());
    await act(async () => newTab().click());
    await settle();
    expect(thumbs()).toHaveLength(0);
    await finish(() => making.resolve(READY));
    // In the tab it was pasted in, where it was put, sent as its note's file.
    expect(imageUrls(docs.get(first)!)).toEqual(["memoca://att-1"]);
    expect(h.stage.mock.calls[0]![0]).toMatchObject({ noteId: first });
    // Let go of once it is in.
    expect(h.release).toHaveBeenCalledWith(first);
  });

  test("a tab let go of while its image is being made ready does not get its draft written back", async () => {
    await render();
    await type("一つ目");
    await act(async () => newTab().click());
    await settle();
    const second = (await loadTabs(ME)).active;
    await paste(png());
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="画像 1 枚 のタブを閉じる"]')!
        .click();
    });
    await settle();
    await act(async () => inDialog("保存せずに閉じる").click());
    await settle();
    expect(field().value).toBe("一つ目");
    await finish(() => making.resolve(READY));
    await pause();
    // Not sent, and its tab's note in the trash: closed on every device.
    expect(h.stage).not.toHaveBeenCalled();
    expect((await db().notes.get(second))?.deletedAt).not.toBeNull();
    expect((await loadTabs(ME)).ids).toHaveLength(1);
  });

  test("one taken out while being made ready is not waited for", async () => {
    await render();
    await type("本文");
    await paste(png());
    await takeOut("写真.png");
    await key({ key: "Enter", metaKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    expect(h.stage).not.toHaveBeenCalled();
    expect(bodyOf("note-1")).toEqual(["本文"]);
    await finish(() => making.resolve(READY));
    expect(thumbs()).toHaveLength(0);
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

  /** What scrolls: the pane the editor is in. */
  const pane = () => field().parentElement!;

  test("keeps the line tapped on in sight as iOS pans to it, and leaves the text be as it pans back", async () => {
    await render("");
    await type("行\n".repeat(200));
    field().focus();
    pane().scrollTop = 300;
    await move({ height: 420, offsetTop: 270 });
    expect(pane().scrollTop).toBe(570);
    await move({ height: 800, offsetTop: 0 });
    expect(pane().scrollTop).toBe(570);
  });

  test("does not scroll what is written while the editor does not have the focus", async () => {
    await render("");
    await type("行\n".repeat(200));
    field().blur();
    pane().scrollTop = 300;
    await move({ height: 420, offsetTop: 270 });
    expect(pane().scrollTop).toBe(300);
  });

  test("clears the home indicator, but not with a keyboard over it", async () => {
    await render("");
    expect(pane().style.paddingBottom).toContain("safe-area-inset-bottom");
    await move({ height: 420 });
    expect(pane().style.paddingBottom).toBe("");
  });

  test("has a place at its foot for the bar of block actions, above the keyboard", async () => {
    await render("");
    expect(host.querySelector("main > div.contents")).not.toBeNull();
  });
});

describe("the quick note, written on while it saves", () => {
  test("typed on while a save runs, the more is not marked saved", async () => {
    let finish!: (id: string) => void;
    h.createNote.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
    await render();
    await type("一");
    await key({ key: "Enter", ctrlKey: true });
    await type("一二");
    await act(async () => finish("note-1"));
    await settle();
    expect(status()).toContain("保存しました");
    expect(bodyOf("note-1")).toEqual(["一"]);
    expect(field().value).toBe("一二");
    // Still something to save.
    expect(button("保存").disabled).toBe(false);
    await pause();
    expect((await draftOf(ME))?.text).toBe("一二");
  });
});

describe("the quick note's folder", () => {
  const chip = () => host.querySelector<HTMLButtonElement>('button[aria-label^="フォルダを選ぶ"]')!;
  async function choose(id: string) {
    await act(async () => chip().click());
    await settle();
    await act(async () => button(`選ぶ:${id}`).click());
    await settle();
  }

  test("is Inbox at first, and says so", async () => {
    await render();
    expect(chip().textContent).toBe("Inbox");
  });

  test("chosen, is saved into, said, and remembered on this device for the next time", async () => {
    await render();
    await choose("work");
    expect(chip().textContent).toBe("仕事");
    await type("仕事のメモ");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledWith({ folderId: "work", title: "", kind: "quick" });
    expect(status()).toContain("仕事 に保存しました");

    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(chip().textContent).toBe("仕事");
  });

  test("one locked since, or gone, is not saved into: Inbox is", async () => {
    await setMeta(`${META.quickFolder}:${ME}`, "vault");
    await render();
    expect(chip().textContent).toBe("Inbox");
    await type("鍵の外");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledWith({ folderId: "inbox-1", title: "", kind: "quick" });
  });

  test("another chosen after a save, saved again: the note goes there too", async () => {
    await render();
    await type("最初");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.move).not.toHaveBeenCalled();
    await choose("work");
    await type("最初\n続き");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.createNote).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith("note-1", "work");
    expect(bodyOf("note-1")).toEqual(["最初", "続き"]);
  });

  test("saved again with the same one chosen, the note is left where it is", async () => {
    await render();
    await type("最初");
    await key({ key: "Enter", ctrlKey: true });
    await type("最初\n続き");
    await key({ key: "Enter", ctrlKey: true });
    expect(h.move).not.toHaveBeenCalled();
  });
});

describe("the quick note, written as a note is", () => {
  /** A draft whose body holds a list and a check, as the editor writes them. */
  async function draftWithList() {
    const { blocksToYDoc } = await import("@blocknote/core/yjs");
    const { editor } = await import("./helpers/blocknote");
    const { FRAGMENT } = await import("@/lib/sync/ydoc");
    const written = blocksToYDoc(
      editor,
      [
        { type: "paragraph", content: "買うもの" },
        { type: "bulletListItem", content: "牛乳" },
        { type: "checkListItem", content: "卵", props: { checked: true } },
        { type: "paragraph", content: "" },
      ],
      FRAGMENT,
    );
    const tabs = await loadTabs(ME);
    await setMeta(`${META.quickDraft}:${tabs.active}`, {
      text: "買うもの\n牛乳\n卵",
      body: Y.encodeStateAsUpdate(written),
      updatedAt: 0,
      userKey: ME,
    });
  }

  test("its lists and checks go into the note as they are, the empty line at its end left out", async () => {
    await draftWithList();
    await render();
    expect(field().value).toBe("買うもの\n牛乳\n卵\n");
    await key({ key: "Enter", ctrlKey: true });
    expect(kindsOf("note-1")).toEqual(["paragraph", "bulletListItem", "checkListItem"]);
    expect(bodyOf("note-1")).toEqual(["買うもの", "牛乳", "卵"]);
  });

  test("saved, its draft keeps the body, and nothing is left to save", async () => {
    await draftWithList();
    await render();
    await key({ key: "Enter", ctrlKey: true });
    await pause();
    // What it was saved as, kept in the tab's note (every device has it): as it is now.
    const doc = docs.get((await loadTabs(ME)).active)!;
    expect(readSaved(doc)?.key).toBe(bodyFragment(doc).toString());
    expect(button("保存").disabled).toBe(true);
  });
});

describe("the quick note's tabs, told what is typed", () => {
  const tabs = () =>
    Array.from(host.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);

  test("a moment later, the latest only; the save button at once", async () => {
    await render();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    for (const value of ["一", "一二", "一二三"]) {
      await act(async () => {
        setter.call(field(), value);
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(tabs()).toEqual(["新しいメモ"]);
    expect(button("保存").disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAB_NAME_DELAY_MS);
    });
    expect(tabs()).toEqual(["一二三"]);
  });

  test("closed at once after typing, a tab with something in it is still asked about", async () => {
    await render();
    await type("一つ目");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="新しいタブ"]')!.click(),
    );
    await settle();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field(), "二つ目");
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Its × before the tabs were told (the tab still named as a new one): asked, not let go of.
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="新しいメモ のタブを閉じる"]')!.click(),
    );
    await settle();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("二つ目");
  });
});

describe("the quick note, as it opens", () => {
  test("is ready to type into", async () => {
    await render();
    expect(document.activeElement).toBe(field());
  });
});

describe("the quick note's Todo tab", () => {
  const tabs = () =>
    Array.from(host.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
  const todoButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Todo を開く"]')!;
  const standIn = () => host.querySelector("[data-todo-stand-in]");
  async function press(element: HTMLElement) {
    await act(async () => element.click());
    await settle();
  }

  test("opened by its button, goes first and is shown; opened again, it is shown, not added twice", async () => {
    await render();
    await type("書きかけ");
    await press(todoButton());
    expect(tabs()).toEqual(["Todo", "書きかけ"]);
    expect(standIn()).not.toBeNull();
    // Back to the other: its draft as it was.
    await press(host.querySelector<HTMLButtonElement>('[role="tab"]:not([aria-selected="true"])')!);
    expect(field().value).toBe("書きかけ");
    await press(todoButton());
    expect(tabs()).toEqual(["Todo", "書きかけ"]);
    expect(standIn()).not.toBeNull();
  });

  test("closed, nothing is asked: what is in it is kept, in the account", async () => {
    await render();
    await press(todoButton());
    await press(host.querySelector<HTMLButtonElement>('button[aria-label="Todo のタブを閉じる"]')!);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(tabs()).toEqual(["新しいメモ"]);
  });

  test("what is shared never goes into it: a tab of its own", async () => {
    await render();
    await press(todoButton());
    await act(async () => root.unmount());
    root = createRoot(host);
    await render("window=1&text=共有された文");
    expect(field().value).toBe("共有された文");
    // The empty one made for this device out of sight: the shared text's shown.
    expect(tabs()).toEqual(["Todo", "共有された文"]);
  });
});

