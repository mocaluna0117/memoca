"use client";

import {
  AppWindow,
  ArrowLeft,
  Check,
  ChevronDown,
  FolderIcon,
  ImagePlus,
  Inbox,
  ListPlus,
  X,
} from "lucide-react";
import { uuidv7 } from "uuidv7";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvex } from "convex/react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import { FolderPicker } from "@/components/folders/folder-picker";
import { QuickTips, Tip } from "@/components/notes/quick-tip";
import { TodoCapture } from "@/components/notes/quick-todo";
import { QuickEditor, type QuickEditorHandle, type QuickImages } from "@/components/notes/quick-editor";
import {
  useStorageUsage,
  useSync,
  useSyncEngine,
  useSyncStatusStore,
} from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { newBuildOut } from "@/lib/build";
import { startImeTrace } from "@/lib/debug/ime-trace";
import { useFolders } from "@/lib/hooks/data";
import { toast } from "sonner";
import { t } from "@/lib/i18n/ja";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { layoutHeight, useVisibleArea } from "@/lib/hooks/use-visible-area";
import { useModKeyLabel } from "@/lib/platform";
import {
  type Allowance,
  idFromRef,
  prepareUpload,
  resolveAttachment,
  stageUpload,
} from "@/lib/media/attachments";
import { uploadRefusal } from "@/lib/media/refusal";
import {
  blockOf,
  copyQuickBody,
  imageUrls,
  prependParagraphs,
  quickKey,
  setImageUrl,
} from "@/lib/quick/body";
import {
  MAX_TABS,
  type SavedAs,
  addFreshTab,
  closeTab,
  loadTabs,
  openTab,
  openTodoTab,
  rememberUnsaved,
  restoreTab,
  showTab,
  unsaved,
  useQuickTabs,
} from "@/lib/quick/draft";
import { makeTabNote, onSavedChange, readSaved, writeSaved } from "@/lib/quick/tabs";
import { wholeBody } from "@/lib/quick/todo";
import { migrateLocalDrafts } from "@/lib/quick/migrate-drafts";
import { db } from "@/lib/db";
import {
  CloseTabDialog,
  type QuickTab,
  QuickTabs,
  holds,
  tabName,
} from "@/components/notes/quick-tabs";
import {
  quickFolderOf,
  quickPickable,
  rememberQuickFolder,
  rememberedQuickFolder,
} from "@/lib/quick/folder";
import { SAVE_KEYS } from "@/lib/quick/keys";
import { useQuickMode } from "@/lib/quick/mode";
import { TODO_TAB_ID, isQuickTab } from "@/lib/quick/todo-id";
import { moveIntoTodo, takeOutOfTodo } from "@/lib/quick/todo-move";
import { SHELL_HIDDEN, closeQuickWindow, inShell, openNoteInApp } from "@/lib/quick/shell";
import { SHARED, holdsShared, joinShared, quickLines } from "@/lib/quick/text";
import { acquireDoc, flushDoc, releaseDoc } from "@/lib/sync/docs";
import { createNote, moveNote } from "@/lib/sync/mutations";
import { bodyFragment, extractText } from "@/lib/sync/ydoc";
import type { Folder } from "@/lib/types";
import { cn } from "@/lib/utils";

/** What the status line says: how the last save went, or why a file was turned away. */
type Status =
  | { kind: "saved"; noteId: string; folder: string }
  | { kind: "failed" }
  /** A file turned away, and why. */
  | { kind: "refused"; message: string }
  | null;

/** What a tab's quick note does for the tabs around it. */
type CaptureHandle = {
  /** Saves it, as its button does: the note all of it is saved in then, if it is. */
  save: () => Promise<string | null>;
  /** Lets go of what is written, its draft not written again as it goes. */
  discard: () => void;
  /** Into its editor, the caret where it was. */
  focus: () => void;
  /** Whether anything in it is not saved, as it is now (the tabs are told a moment later). */
  holds: () => boolean;
  /** Tells the tabs now what it holds, rather than a moment later. */
  tellNow: () => void;
};

/**
 * How long the tabs wait to be told what is typed: a tab's name follows its
 * first line, which every key in it changes, and each telling draws the
 * tabs and the header again. The save button follows at once.
 */
export const TAB_NAME_DELAY_MS = 150;

/** The folder a quick note is saved into: its id (none, the top level), its name, and whether it is Inbox. */
type QuickFolder = { id: string | null; name: string; inbox: boolean };

/** A folder's name as the chip says it: Inbox's, whatever it holds. */
const folderName = (folder: Folder | undefined) =>
  folder?.system === "inbox" || !folder ? t.nav.inbox : (folder.name ?? t.nav.inbox);

/** What a tab holds of text now: its text, and what its body says (lib/quick/body quickKey). */
const textOf = (doc: Y.Doc) => ({ text: extractText(doc), key: quickKey(doc) });
/** The most images one quick note takes. */
const MAX_IMAGES = 10;

/** Whether a file is an image, or one a phone sends as a HEIC photo with no type. */
const isImage = (file: File) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);

/** What is still said as the window goes: why an image was turned away; not that it was saved. */
const stillSaid = (said: Status): Status => (said?.kind === "refused" ? said : null);

/**
 * Once every image still being made ready is: ready, or turned away. One
 * added while that is waited for is waited for too.
 */
async function allReady(jobs: Map<string, Promise<void>>): Promise<void> {
  while (jobs.size > 0) await Promise.all(jobs.values());
}

/** An input method still choosing a word: its keys are its own, Safari's too. */
const composing = (event: { isComposing: boolean; keyCode: number }) =>
  event.isComposing || event.keyCode === 229;

/**
 * Write first, organise later.
 *
 * No title to invent: whatever is typed lands, as a normal note, in the folder
 * last chosen for it on this device (Inbox at first), so it can be moved,
 * locked or edited in the full editor afterwards. It is written as a note is,
 * lists, checks, toggles and headings and all. Android's share sheet and the
 * home-screen shortcut both arrive here with the text prefilled.
 *
 * As a page (a phone), a save opens the note. As a window of its own (the
 * desktop shell, or a window the web app opens), it stays, emptied for the
 * next one, and Esc puts it away. Either way what is being written is kept
 * as a draft on this device, for this account, until it is saved.
 *
 * In tabs, as a text editor's: each a draft of its own. A tab saved stays as
 * it is, and saved again writes over the note it was saved as; one closed
 * with something not saved in it is asked about first.
 */
export function QuickCapture() {
  const { me } = useSync();
  // The storage figures apart from the account (see sync-provider): a file
  // added is checked against them as they are.
  const usage = useStorageUsage();
  const params = useSearchParams();
  // Temporary, in the Mac desktop app: ⌘⌥⇧I starts the input record, and again copies it.
  useEffect(
    () =>
      startImeTrace({
        onStarted: () => toast("入力の記録を始めました。もう一度 ⌘⌥⇧I を押すとコピーします"),
        onCopied: () => toast.success("入力の記録をコピーしました"),
      }),
    [],
  );
  // Android's share sheet and the home-screen shortcut arrive with the text in
  // the query string, so the first render already has it. Read once, it
  // leaves the address: the page loaded again would add it a second time.
  const [shared] = useState(() =>
    joinShared({ title: params.get("title"), text: params.get("text"), url: params.get("url") }),
  );
  // A reminder of the Todo's touched: the Todo shown (once, as it opens).
  const [toTodo] = useState(() => params.get("todo") === "1");
  useEffect(() => {
    if (!SHARED.some((name) => params.has(name)) && !params.has("todo")) return;
    const address = new URL(window.location.href);
    for (const name of [...SHARED, "todo"]) address.searchParams.delete(name);
    window.history.replaceState(null, "", address.pathname + address.search);
    // Once: what the address held is read on the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Another account signed in on this device starts afresh: no draft of the
  // last one's, nor anything typed while it was shown, is carried over. What
  // was shared is, being the one at the device's.
  return (
    <QuickTips>
      <Tabbed
        key={me?.userKey ?? ""}
        userKey={me?.userKey ?? ""}
        inbox={me?.inboxFolderId ?? null}
        allowance={usage}
        shared={shared}
        toTodo={toTodo}
      />
    </QuickTips>
  );
}

/**
 * The tabs, and the one shown. What was shared goes into the tab shown if it
 * is empty, a new tab otherwise, so that no draft has it put into it.
 */
function Tabbed({
  userKey,
  inbox,
  allowance,
  shared,
  toTodo,
}: {
  userKey: string;
  inbox: string | null;
  allowance: Allowance | null;
  shared: string;
  /** Opened from a reminder of the Todo's: the Todo shown. */
  toTodo: boolean;
}) {
  const live = useQuickTabs(userKey);
  // What was shared, and the tab it goes into, until another tab is shown:
  // read by that tab's quick note as it starts, never again.
  const [share, setShare] = useState<{ tab: string; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  // The folder chosen to save into, on this device, for every tab; and the
  // folders as first read, until they are followed (so that the chip does
  // not say Inbox for a moment before it says the folder chosen).
  const [chosen, setChosen] = useState<string | null>(null);
  const [firstFolders, setFirstFolders] = useState<Folder[]>([]);
  const [picking, setPicking] = useState(false);
  const followed = useFolders();
  const folders = followed.length > 0 ? followed : firstFolders;
  const folderId = quickFolderOf(chosen, inbox, folders);
  const folder: QuickFolder = {
    id: folderId,
    name: folderName(folders.find((each) => each.folderId === folderId)),
    inbox: folderId === inbox,
  };
  useEffect(() => {
    let current = true;
    void (async () => {
      // This device's drafts of its own, from before the tabs were the
      // account's, made its tabs' notes first (once).
      await migrateLocalDrafts(userKey).catch(() => undefined);
      const [tabs, remembered, all] = await Promise.all([
        loadTabs(userKey),
        rememberedQuickFolder(userKey).catch(() => null),
        db().folders.toArray(),
      ]);
      if (current) {
        setChosen(remembered);
        setFirstFolders(all);
      }
      if (toTodo && !shared) await openTodoTab(userKey);
      if (shared) {
        // What the tab shown holds, read from its note (its first line, for
        // the tabs, may not be written yet: a draft made its note a moment ago).
        let there = "";
        if (isQuickTab(tabs.active) && (await db().notes.get(tabs.active))) {
          const body = await acquireDoc(tabs.active);
          try {
            there = extractText(body);
          } finally {
            await releaseDoc(tabs.active);
          }
        }
        // Into the tab shown if it is empty (or holds it already); never the Todo's.
        const busy =
          tabs.active === TODO_TAB_ID || (there.trim() !== "" && !holdsShared(there, shared));
        const tab = busy ? ((await openTab(userKey)) ?? tabs.active) : tabs.active;
        if (current) setShare({ tab, text: shared });
      }
    })()
      .catch(() => undefined)
      .finally(() => current && setReady(true));
    return () => {
      current = false;
    };
    // Once for the account: a new one is a new Tabbed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const capture = useRef<CaptureHandle>(null);
  const syncStatus = useSyncStatusStore();
  const syncEngine = useSyncEngine();
  // The tab shown's text as typed, before its draft is written.
  const [typed, setTyped] = useState<QuickTab | null>(null);
  // The tab asked about before it is closed.
  const [closing, setClosing] = useState<string | null>(null);

  const active = live?.tabs.active || null;
  const tabs: QuickTab[] = (live?.tabs.ids ?? []).map((id) => {
    // The Todo's: written as it is typed, never anything to save.
    if (id === TODO_TAB_ID)
      return { id, text: t.quick.todo, images: 0, unsaved: false, todo: true };
    if (typed?.id === id) return typed;
    const face = live?.faces.get(id);
    return { id, text: face?.text ?? "", images: face?.images ?? 0, unsaved: face?.unsaved ?? false };
  });
  // Every tab closed (here, or on another device): a new, empty one. Not
  // while a draft of this device's own is still to be made a tab's note
  // (its tab not shown until it is).
  const none =
    ready &&
    live !== undefined &&
    !tabs.some((tab) => !tab.todo) &&
    !live.own.some((id) => id !== TODO_TAB_ID && !isQuickTab(id));
  useEffect(() => {
    if (none) void addFreshTab(userKey);
  }, [none, userKey]);

  // Said by the tab shown next, once one is saved and closed.
  const [notice, setNotice] = useState<Status>(null);
  /** Another tab shown, or one opened or closed: what was shared and said is for the tab it was. */
  const moving = () => {
    setShare(null);
    setNotice(null);
  };
  const show = (id: string) => {
    if (id === active) return;
    moving();
    void showTab(userKey, id);
  };
  const open = () => {
    moving();
    void openTab(userKey);
  };
  const openTodo = () => {
    if (active === TODO_TAB_ID) return;
    moving();
    void openTodoTab(userKey);
  };
  /** Closes a tab: at once if there is nothing in it, asked about first if there is. */
  const close = async (id: string) => {
    const tab = tabs.find((each) => each.id === id);
    if (!tab || tabs.length < 2) return;
    // The tab shown, as it is now: the tabs are told what is typed a moment later.
    if (id === active) capture.current?.tellNow();
    const live = id === active ? (capture.current?.holds() ?? holds(tab)) : holds(tab);
    if (!live) {
      moving();
      if (id === active) capture.current?.discard();
      await closeTab(userKey, id);
      return;
    }
    if (id !== active) {
      moving();
      await showTab(userKey, id);
    }
    setClosing(id);
  };
  // In the desktop shell, a text editor's keys: a browser keeps them to itself.
  // Listened for once; what a key does is read as it is pressed, so the
  // listener is not taken off and put back on each render.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const ids = live?.tabs.ids ?? [];
    const shown = live?.tabs.active;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      if (ids.length < MAX_TABS) open();
    } else if (mod && !event.shiftKey && event.key.toLowerCase() === "w") {
      event.preventDefault();
      if (shown) void close(shown);
    } else if (event.ctrlKey && event.key === "Tab" && shown && ids.length > 1) {
      event.preventDefault();
      const at = ids.indexOf(shown);
      show(ids[(at + (event.shiftKey ? -1 : 1) + ids.length) % ids.length]!);
    }
  });
  useEffect(() => {
    if (!inShell()) return;
    const listener = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  /**
   * A tab all of whose lines went into the Todo: closed, and the Todo shown,
   * with 元に戻す (the items taken out again, the tab put back as it was).
   */
  const movedAll = async (id: string, ids: string[]) => {
    const at = live?.tabs.ids.indexOf(id) ?? 0;
    moving();
    capture.current?.discard();
    await closeTab(userKey, id);
    await openTodoTab(userKey);
    toast(t.quick.movedToTodo(ids.length), {
      action: {
        label: t.quick.undo,
        onClick: () =>
          void (async () => {
            await takeOutOfTodo(ids, { status: syncStatus, engine: syncEngine });
            moving();
            await restoreTab(userKey, id, at);
          })().catch(() => toast.error(t.quick.moveFailed)),
      },
    });
  };

  if (!ready || !live || !active) return null;
  const asked = closing ? tabs.find((tab) => tab.id === closing) : undefined;
  const strip = (
    <QuickTabs
      tabs={tabs}
      active={active}
      canOpen={tabs.length < MAX_TABS}
      onShow={show}
      onOpen={open}
      onClose={(id) => void close(id)}
      onOpenTodo={openTodo}
    />
  );
  return (
    <>
      {active === TODO_TAB_ID ? (
        <TodoCapture strip={strip} escapeEnabled={closing === null && !picking} />
      ) : (
        <Capture
          key={active}
          handle={capture}
          noteId={active}
          folder={folder}
          onPickFolder={() => setPicking(true)}
          allowance={allowance}
          shared={share?.tab === active ? share.text : ""}
          initialStatus={notice}
          escapeEnabled={closing === null && !picking}
          onText={(text, images, changed) => {
            setTyped({ id: active, text, images, unsaved: changed });
            // For the tab once it is not shown: closed, asked about or not.
            void rememberUnsaved(userKey, active, changed).catch(() => undefined);
          }}
          onMovedAll={(ids) => void movedAll(active, ids)}
          strip={strip}
        />
      )}
      <CloseTabDialog
        name={asked ? tabName(asked) : ""}
        open={asked !== undefined}
        onCancel={() => setClosing(null)}
        onSave={async () => {
          const id = closing;
          setClosing(null);
          // Closed once it is saved, the next tab saying so; kept, saying
          // why, if it could not be.
          const noteId = id ? await capture.current?.save() : null;
          if (!id || !noteId) return;
          moving();
          setNotice({ kind: "saved", noteId, folder: folder.name });
          capture.current?.discard();
          await closeTab(userKey, id);
        }}
        onDiscard={() => {
          const id = closing;
          setClosing(null);
          if (!id) return;
          moving();
          capture.current?.discard();
          void closeTab(userKey, id);
        }}
      />
      <FolderPicker
        open={picking}
        onOpenChange={setPicking}
        title={t.quick.folderTitle}
        description={t.quick.folderDescription}
        canPick={quickPickable}
        onPick={(id) => {
          if (!id) return;
          setChosen(id);
          void rememberQuickFolder(userKey, id).catch(() => undefined);
        }}
        // Back to writing, where it was.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          capture.current?.focus();
        }}
      />
    </>
  );
}

function Capture({
  handle,
  noteId,
  folder,
  onPickFolder,
  allowance,
  shared,
  initialStatus,
  escapeEnabled,
  onText,
  onMovedAll,
  strip,
}: {
  handle: Ref<CaptureHandle>;
  /** The tab this is: its note, which holds what is written in it (lib/quick/tabs). */
  noteId: string;
  /** The folder it is saved into, as chosen for every tab. */
  folder: QuickFolder;
  /** Another folder to be chosen. */
  onPickFolder: () => void;
  /** The account's figures, for an image to be checked against before it is added. */
  allowance: Allowance | null;
  shared: string;
  /** What the status line says first: that the tab before it was saved and closed. */
  initialStatus: Status;
  /** Esc puts the window away: not while a dialog over it is open. */
  escapeEnabled: boolean;
  /** What it holds, as typed, and whether any of it is not saved. */
  onText: (text: string, images: number, unsaved: boolean) => void;
  /** All of its lines moved into the Todo, and nothing else (no image) left: the items' ids. */
  onMovedAll: (ids: string[]) => void;
  /** The tabs, under the header. */
  strip: ReactNode;
}) {
  const router = useRouter();
  const client = useConvex();
  const windowed = useQuickMode() === "window";
  // The desktop shell's window for the whole app, to be brought out from
  // here: not in shells before 0.4.1.
  const canShowApp = useClientValue(() => typeof window.memocaShell?.showApp === "function", false);
  const modKey = useModKeyLabel();
  const area = useVisibleArea();
  // What is written, as a note's body is: the tab's note's own document,
  // synced as any note's is, edited by its editor, and copied into a note
  // of its own as it is saved. Shown once all of it is here (see the effect).
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const editor = useRef<QuickEditorHandle>(null);
  const syncStatus = useSyncStatusStore();
  const syncEngine = useSyncEngine();
  /** Lines being moved into the Todo: one move at a time. */
  const [toTodo, setToTodo] = useState(false);
  /** Where the bar of block actions goes on a phone: the page's foot, above the keyboard. */
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(initialStatus);
  const statusRef = useRef<Status>(initialStatus);
  const say = (next: Status) => {
    statusRef.current = next;
    setStatus(next);
  };
  // Whether any of it is not saved: what the save button follows.
  const [changed, setChanged] = useState(false);
  const changedRef = useRef(false);
  // What the tab was last saved as (kept in its note, the same on every
  // device): saved again, that note is written over.
  const savedRef = useRef<SavedAs | null>(null);
  /** The folder it is saved into, as it is when a save starts. */
  const folderRef = useRef(folder);
  useLayoutEffect(() => {
    folderRef.current = folder;
  });
  /** What the tabs were last told of it, as they show it: its name, its images, whether it is saved. */
  const reported = useRef<{ name: string; images: number; changed: boolean } | null>(null);
  /**
   * Tells the tabs what it holds now, and whether all of it is saved: only
   * as what they show of it changes, not on every key, which would render
   * them all again.
   */
  const report = (seen?: { text: string; key: string }, atOnce = true) => {
    const body = docRef.current;
    if (!body) return { changed: false };
    const { text, key } = seen ?? textOf(body);
    const pictures = heldImages(body);
    const images = pictures.length;
    const now = {
      name: tabName({ text, images }),
      images,
      changed: unsaved({ text, key, images: pictures, saved: savedRef.current }),
    };
    // Only as it changes: even the same value set draws it again, now and then.
    if (changedRef.current !== now.changed) {
      changedRef.current = now.changed;
      setChanged(now.changed);
    }
    const last = reported.current;
    if (last && last.name === now.name && last.images === images && last.changed === now.changed) {
      return now;
    }
    reported.current = now;
    tell([text, images, now.changed], atOnce);
    return now;
  };
  /** What the tabs are still to be told, and when. */
  const telling = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    told: [string, number, boolean] | null;
  }>({ timer: null, told: null });
  const onTextRef = useRef(onText);
  useLayoutEffect(() => {
    onTextRef.current = onText;
  });
  const tellNow = () => {
    const pending = telling.current;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    const told = pending.told;
    pending.told = null;
    if (told) onTextRef.current(...told);
  };
  /** Tells the tabs: at once, or (as it is typed) a moment later, the latest only. */
  const tell = (told: [string, number, boolean], atOnce: boolean) => {
    telling.current.told = told;
    if (atOnce) return tellNow();
    telling.current.timer ??= setTimeout(tellNow, TAB_NAME_DELAY_MS);
  };
  // Told before it goes: another tab shown, its last name is not lost.
  useEffect(() => () => tellNow(), []);
  /** Its text as last seen: what is said goes once it is written in. */
  const lastText = useRef("");
  const scroller = useRef<HTMLDivElement>(null);
  // iOS pans what is seen down to the caret as its keyboard comes up, and the
  // page, kept to what is seen, takes back just as much, the caret's line
  // going with it, under the keyboard: what is written is scrolled by the
  // same, so the line tapped on stays where iOS put it. The pan back as the
  // keyboard goes is not followed: the text stays where it is on the screen.
  const lastTop = useRef(0);
  useLayoutEffect(() => {
    // Zoomed in (no area), the page is left where it is, and so is this.
    if (windowed || !area) return;
    const moved = area.top - lastTop.current;
    lastTop.current = area.top;
    const element = scroller.current;
    if (moved > 0 && element?.contains(document.activeElement)) element.scrollTop += moved;
  }, [windowed, area]);
  // With a keyboard up the home indicator is under it: nothing to clear. (The
  // root's height is the layout viewport's, which neither iOS's keyboard nor
  // Chrome's, resizing only what is seen, makes shorter.)
  const keyboard = !windowed && area !== null && area.height < layoutHeight() - 100;
  /** A save under way, for closing to wait for. */
  const inFlight = useRef<Promise<void> | null>(null);
  /** The note a save made and could not finish, for the next save to finish. */
  const unfinished = useRef<string | null>(null);

  /**
   * Its images: those its body shows (each the note's own file, uploaded as
   * one pasted into a note is), and those still being made ready, for its
   * name and for closing it.
   */
  const heldImages = (from: Y.Doc) => [
    ...imageUrls(from).map((key) => ({ key })),
    ...[...preparing.current.keys()].map((key) => ({ key })),
  ];
  /** The block each image still being made ready is shown loading in, by its key. */
  const loadingIn = useRef(new Map<string, string>());
  /** The images taken out (their blocks) while they were made ready: not sent. */
  const takenOut = useRef(new Set<string>());
  const picker = useRef<HTMLInputElement>(null);
  /** Each image still being made ready, by key: a save, and the window's going, wait for it. */
  const preparing = useRef(new Map<string, Promise<void>>());
  /**
   * The preparations, one after another: each holds its whole bitmap (and
   * more, on WebKit) until the worker takes it, which ten at once would not fit.
   */
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** How many images were turned away: one more while a save waits, and it saves nothing over the reason. */
  const refusals = useRef(0);
  /** Whether this tab's quick note is still shown. */
  const mounted = useRef(false);
  /** Whether what is written was let go of (the tab closed unsaved). */
  const discarded = useRef(false);

  useEffect(() => {
    mounted.current = true;
    // The tab's note, made if this device opened it a moment ago; then all
    // of it the server has (a tab another device wrote in), before the
    // editor is shown on its document: an editor shown on less writes its
    // own empty line into it, beside the server's. Then what was shared,
    // above what it holds (where it does not hold it already).
    let current = true;
    let held: Y.Doc | null = null;
    void (async () => {
      const row = await db().notes.get(noteId);
      if (!row) await makeTabNote(noteId);
      // One the server has edits of (written on another device): all of them first.
      else if (row.lastUpdateSeq > 0 || row.snapshotSeq > 0) await wholeBody(noteId, syncEngine, () => !current);
      const body = await acquireDoc(noteId);
      if (!current) {
        void releaseDoc(noteId);
        return;
      }
      held = body;
      savedRef.current = readSaved(body);
      if (shared && !holdsShared(extractText(body), shared)) {
        prependParagraphs(body, [...quickLines(shared), ...(extractText(body) ? [""] : [])]);
      }
      docRef.current = body;
      lastText.current = textOf(body).text;
      report();
      setDoc(body);
    })().catch(() => {
      if (current) say({ kind: "failed" });
    });
    // The images being made ready: the one map all along, read as the tab goes.
    const jobs = preparing.current;
    return () => {
      current = false;
      mounted.current = false;
      if (!held) return;
      // An image still being made ready as the tab goes (another shown, the
      // page left) goes into its block once it is, the note let go of then.
      void allReady(jobs)
        .then(() => flushDoc(noteId))
        .catch(() => undefined)
        .finally(() => void releaseDoc(noteId));
    };
    // Once for the tab: another is a new Capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // What it was saved as, saved here or on another device: the save button
  // and the tabs follow.
  useEffect(() => {
    if (!doc) return;
    return onSavedChange(doc, () => {
      savedRef.current = readSaved(doc);
      report();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Every change to what is written (here, or on another device): to the
  // tabs and the save button as they show it. What was said goes once
  // something is written: not as the editor writes its first, empty line
  // into an empty tab, which would take away that the tab before it was saved.
  const onEdit = useEffectEvent(() => {
    const body = docRef.current;
    if (!body) return;
    // One taken out while it is made ready is not waited for any more.
    for (const [key, blockId] of loadingIn.current) {
      if (blockOf(body, blockId)) continue;
      loadingIn.current.delete(key);
      preparing.current.delete(key);
      takenOut.current.add(key);
    }
    const seen = textOf(body);
    const wasChanged = reported.current?.changed ?? false;
    const { changed: nowChanged } = report(seen, false);
    // Why an image was turned away stays said as the others come in.
    const typed = seen.text !== lastText.current;
    const written = typed || (nowChanged && !wasChanged && statusRef.current?.kind !== "refused");
    lastText.current = seen.text;
    if (written && statusRef.current) say(null);
  });
  useEffect(() => {
    if (!doc) return;
    // Its body observed, not the document's updates: with something
    // listening for those, Yjs writes each change out as one, every key.
    const body = bodyFragment(doc);
    const listener = () => onEdit();
    body.observeDeep(listener);
    return () => body.unobserveDeep(listener);
  }, [doc]);

  useEffect(() => {
    // Into the editor as it is shown: the editor's own (autoFocus).
    if (!doc || !windowed) return;
    // Shown again by the shell, or brought forward: ready to type into.
    const refocus = () => editor.current?.focus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, [doc, windowed]);

  /**
   * Makes a file pasted, dropped or chosen ready as an image, as one added
   * to a note is (compressed, and checked), one after another, and stages it
   * to go up as the tab's note's own file (offline too): its block
   * (`blockId`, which BlockNote shows loading meanwhile) is given its
   * reference, even once the tab is gone. One that cannot be is turned
   * away, said why: BlockNote's block for it is put right. A save, and the
   * window's going, wait for those still being made ready.
   */
  const prepare = (file: File, blockId?: string): Promise<string> => {
    const body = docRef.current;
    if (!isImage(file)) {
      say({ kind: "refused", message: t.quick.imagesOnly });
      return Promise.reject(new Error("not an image"));
    }
    if (!body || imageUrls(body).length + preparing.current.size >= MAX_IMAGES) {
      say({ kind: "refused", message: t.quick.tooManyImages(MAX_IMAGES) });
      return Promise.reject(new Error("too many images"));
    }
    const key = uuidv7();
    const name = file.name || "image";
    if (blockId) loadingIn.current.set(key, blockId);
    const job = chain.current
      .then(async () => {
        const prepared = await prepareUpload(file, allowance);
        // Taken out meanwhile (or its tab closed unsaved, here or on another
        // device): nothing to put it in, nor to send.
        if (takenOut.current.has(key) || discarded.current) throw new Error("taken out");
        if ((await db().notes.get(noteId))?.deletedAt) throw new Error("taken out");
        return stageUpload({ noteId, file, prepared });
      })
      .then(
        (ref) => {
          if (blockId) setImageUrl(body, blockId, ref, name);
          return ref;
        },
        (error: unknown) => {
          if (!takenOut.current.has(key) && !discarded.current) {
            refusals.current += 1;
            if (mounted.current) say({ kind: "refused", message: uploadRefusal(error) });
          }
          throw error;
        },
      )
      .finally(() => {
        preparing.current.delete(key);
        loadingIn.current.delete(key);
        if (mounted.current) report();
      });
    preparing.current.set(
      key,
      job.then(
        () => undefined,
        () => undefined,
      ),
    );
    report();
    // The next waits for this one, however it ends.
    chain.current = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  };
  /** Waits for a save under way, keeps what is written, and puts the window away. */
  const close = useCallback(async () => {
    await inFlight.current;
    // A window of a page's is unloaded as it closes, an image still being
    // made ready with it. The shell keeps the page, and waits for the image
    // itself as it puts the window away (SHELL_HIDDEN): not kept up for it.
    if (!window.memocaShell) await allReady(preparing.current);
    await flushDoc(noteId).catch(() => undefined);
    // Shown again by the shell, the window should not still say saved.
    say(stillSaid(statusRef.current));
    closeQuickWindow();
  }, [noteId]);

  /** As {@link close}, Memoca's own window brought out in its place, as it was left. */
  const showApp = useCallback(async () => {
    await inFlight.current;
    // The shell's alone: an image still being made ready is waited for as
    // it puts the window away.
    await flushDoc(noteId).catch(() => undefined);
    say(stillSaid(statusRef.current));
    window.memocaShell?.showApp?.();
  }, [noteId]);

  useEffect(() => {
    if (!windowed) return;
    // Put away by the desktop shell, which keeps the window loaded: what is
    // written is kept, and a new version of the site is loaded out of sight
    // (nothing else would ever load this page again).
    const hidden = async () => {
      await inFlight.current;
      await allReady(preparing.current);
      await flushDoc(noteId).catch(() => undefined);
      say(stillSaid(statusRef.current));
      // Out again by the time the server says (and maybe being typed in):
      // left for the next time it is put away.
      if ((await newBuildOut()) && !document.hasFocus()) window.location.reload();
    };
    window.addEventListener(SHELL_HIDDEN, hidden);
    return () => window.removeEventListener(SHELL_HIDDEN, hidden);
  }, [windowed, noteId]);

  useEffect(() => {
    if (!windowed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || composing(event) || event.defaultPrevented) return;
      // One closing the dialog over it, not the window.
      if (!escapeEnabled) return;
      event.preventDefault();
      void close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [windowed, close, escapeEnabled]);

  const save = async (): Promise<void> => {
    // One at a time: ⌘ + Enter again while the first waits for an image is
    // not another; a tab's closing, asking, waits for the one under way.
    if (inFlight.current) return inFlight.current;
    const body = docRef.current;
    if (!body) return;
    const run = (async () => {
      // An image still being made ready goes in as it will be once it is;
      // one turned away meanwhile is said, and nothing is saved over that.
      const refused = refusals.current;
      await allReady(preparing.current);
      if (refusals.current !== refused) return;
      // What is saved: what is written as it is now, in a document of its
      // own. Typed on while the save runs, the editor holds more, which is
      // not saved, and is not marked so.
      const snapshot = new Y.Doc();
      Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(body));
      const { text, key } = textOf(snapshot);
      // Its images: those it shows, where it shows them, each its file's reference.
      const pictures = imageUrls(snapshot).map((url) => ({ key: url }));
      if (text.trim() === "" && pictures.length === 0) return;
      // Saved already, as it is: nothing to write again.
      if (!unsaved({ text, key, images: pictures, saved: savedRef.current })) return;
      const target = folderRef.current;
      setSaving(true);
      say(null);
      try {
        // Into the note it was saved as before, while that is still there, as
        // a text editor saves a document again; or a new one, with no title:
        // its first line stands in for one where notes are listed.
        const before = savedRef.current ? await db().notes.get(savedRef.current.noteId) : undefined;
        const again = before && before.deletedAt === null && !before.purged ? before.noteId : null;
        const saved =
          unfinished.current ??
          again ??
          (await createNote({ folderId: target.id, title: "", kind: "quick" }));
        unfinished.current = saved;
        // Saved again with another folder chosen since: there too. Not moved
        // back where it was saved, if it has been moved since.
        const chosenThen = savedRef.current?.folderId;
        if (saved === again && chosenThen !== undefined && chosenThen !== target.id) {
          await moveNote(saved, target.id);
        }

        // All of it goes straight into the note's document, so the full editor
        // opens on exactly what was written here, over whatever a save that
        // did not finish may have written. Its images with it, the tab's
        // note's files, used by this note too, as a block copied between
        // notes is.
        const note = await acquireDoc(saved);
        try {
          copyQuickBody(snapshot, note, []);
        } finally {
          await releaseDoc(saved);
        }
        unfinished.current = null;

        // Kept as it is, as what it was saved as, in the tab's note (every
        // device has it): the tab stays.
        const now: SavedAs = {
          noteId: saved,
          text,
          key,
          folderId: target.id,
          images: pictures.map((image) => image.key),
        };
        savedRef.current = now;
        writeSaved(body, now);
        await flushDoc(noteId).catch(() => undefined);
        report();
        if (!windowed) {
          router.replace(`/app?${new URLSearchParams({ n: saved })}`);
        } else {
          say({ kind: "saved", noteId: saved, folder: target.name });
          editor.current?.focus();
        }
      } catch {
        // Kept as it is, to be saved again: into the note already made, if one was.
        say({ kind: "failed" });
      } finally {
        setSaving(false);
      }
    })();
    inFlight.current = run;
    await run;
    if (inFlight.current === run) inFlight.current = null;
  };

  /**
   * The lines selected (or, with none, all of them) moved into the Todo,
   * as its items, and taken out of here, with 元に戻す. All of them, with no
   * images: the tab closed (see onMovedAll).
   */
  const moveToTodo = async () => {
    if (toTodo) return;
    const taken = editor.current?.linesForTodo();
    if (!taken) return;
    const sync = { status: syncStatus, engine: syncEngine };
    setToTodo(true);
    try {
      const ids = await moveIntoTodo(taken.blocks, sync);
      if (ids.length === 0) {
        toast(t.quick.nothingToMove);
        return;
      }
      // Its lines go; an image (or a table) stays where it is.
      const lines = taken.blocks.filter((block) => Array.isArray(block.content));
      const stays = lines.length < taken.blocks.length;
      if (taken.all && !stays) {
        await flushDoc(noteId).catch(() => undefined);
        onMovedAll(ids);
        return;
      }
      editor.current?.remove(lines.map((block) => block.id));
      const here = editor.current;
      toast(t.quick.movedToTodo(ids.length), {
        description: stays ? t.quick.imagesStay : undefined,
        action: {
          label: t.quick.undo,
          onClick: () => {
            // Gone from here (another tab shown): left in the Todo.
            if (!here || editor.current !== here) return;
            here.putBack(lines, taken.after);
            void takeOutOfTodo(ids, sync).catch(() => toast.error(t.quick.moveFailed));
          },
        },
      });
    } catch {
      toast.error(t.quick.moveFailed);
    } finally {
      setToTodo(false);
    }
  };

  // What the editor is handed: the same functions all along, so that what
  // draws the header and the tabs again does not draw the editor again.
  const latest = useRef<{
    save: () => void;
    begin: () => void;
    prepare: (file: File, blockId?: string) => Promise<string>;
    escape: () => void;
  }>({
    save: () => {},
    begin: () => {},
    prepare: () => Promise.reject(new Error("not ready")),
    escape: () => {},
  });
  useLayoutEffect(() => {
    latest.current = {
      save: () => void save(),
      begin: () => {
        if (statusRef.current?.kind === "refused") say(null);
      },
      prepare,
      escape: () => {
        if (escapeEnabled) void close();
      },
    };
  });
  const onSave = useCallback(() => latest.current.save(), []);
  const onEscape = useCallback(() => latest.current.escape(), []);
  /** The images, for the editor: made ready and sent here, and shown as a note's are. */
  const quickImages = useMemo<QuickImages>(
    () => ({
      // What was said of the files before is over, as more come in.
      begin: () => latest.current.begin(),
      prepare: (file, blockId) => latest.current.prepare(file, blockId),
      shown: async (ref) => {
        const id = idFromRef(ref);
        return id ? ((await resolveAttachment(client, id)) ?? ref) : ref;
      },
    }),
    [client],
  );

  useImperativeHandle(handle, () => ({
    save: async () => {
      await save();
      const body = docRef.current;
      if (!body) return null;
      const all = !unsaved({
        ...textOf(body),
        images: imageUrls(body).map((key) => ({ key })),
        saved: savedRef.current,
      });
      return all ? (savedRef.current?.noteId ?? null) : null;
    },
    discard: () => {
      discarded.current = true;
    },
    focus: () => editor.current?.focus(),
    holds: () => {
      const body = docRef.current;
      return body ? unsaved({ ...textOf(body), images: heldImages(body), saved: savedRef.current }) : false;
    },
    tellNow,
  }));

  const link = "text-foreground underline underline-offset-2";
  const said =
    status?.kind === "saved" ? (
      <>
        {t.quick.savedIn(status.folder)} ・{" "}
        <button type="button" className={link} onClick={() => openNoteInApp(status.noteId)}>
          {t.quick.openNote}
        </button>
      </>
    ) : status?.kind === "refused" ? (
      status.message
    ) : status?.kind === "failed" ? (
      t.quick.failed
    ) : null;
  // Always in the page, even empty: a screen reader announces what comes into
  // a region it already knows, not one that has just appeared.
  const statusLine = (
    <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
      {said ? <span className={cn("block", !windowed && "px-4 py-1.5")}>{said}</span> : null}
    </p>
  );
  const FolderMark = folder.inbox ? Inbox : FolderIcon;

  return (
    <main
      // What is written scrolls inside its pane, and the header, its save
      // button with it, stays in sight. A page is kept to what can be seen
      // of it: on a phone, what the keyboard leaves, wherever iOS has panned
      // to show the caret, which would otherwise take the header out of sight.
      className={cn("flex flex-col", windowed ? "h-dvh" : "fixed inset-x-0 top-0 h-dvh")}
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        ...(windowed || !area
          ? {}
          : { height: area.height, transform: area.top ? `translateY(${area.top}px)` : undefined }),
      }}
    >
      <div className="border-b bg-background">
        {/* The desktop shell's window has no title bar: it is moved by this. */}
        <header
          className="flex items-center gap-1.5 px-2 py-2"
          data-tauri-drag-region={windowed || undefined}
        >
          {windowed ? null : (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push("/app")}
              aria-label={t.quick.back}
            >
              <ArrowLeft className="size-5" aria-hidden />
            </Button>
          )}
          <h1
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              windowed && "pl-2 select-none",
            )}
            data-tauri-drag-region={windowed || undefined}
          >
            {t.nav.quick}
          </h1>
          {canShowApp ? (
            <Tip label={t.quick.openApp}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void showApp()}
                aria-label={t.quick.openApp}
              >
                <AppWindow className="size-4" aria-hidden />
              </Button>
            </Tip>
          ) : null}
          <Tip label={t.quick.moveToTodoTip}>
            <Button
              variant="ghost"
              size="icon"
              // The selection stays as it is, for what is selected to be moved.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void moveToTodo()}
              disabled={saving || toTodo}
              aria-label={t.quick.moveToTodo}
            >
              <ListPlus className="size-4" aria-hidden />
            </Button>
          </Tip>
          <Tip label={t.quick.addImage}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => picker.current?.click()}
              disabled={saving}
              aria-label={t.quick.addImage}
            >
              <ImagePlus className="size-4" aria-hidden />
            </Button>
          </Tip>
          <input
            ref={picker}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              editor.current?.insertImages(files);
            }}
          />
          {/* Where it is saved: the folder's name, to choose another. */}
          <Tip label={t.quick.folder(folder.name)}>
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 shrink gap-1 px-2 font-normal"
              onClick={onPickFolder}
              disabled={saving}
              aria-label={t.quick.folderLabel(folder.name)}
            >
              <FolderMark className="size-3.5 shrink-0 opacity-70" aria-hidden />
              <span className="max-w-[8rem] truncate">{folder.name}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
            </Button>
          </Tip>
          <Tip label={t.quick.saveTip(modKey)}>
            <Button
              size="sm"
              className="shrink-0"
              onClick={save}
              disabled={saving || !changed}
              aria-keyshortcuts={SAVE_KEYS}
            >
              <Check className="size-4" aria-hidden />
              {t.action.save}
            </Button>
          </Tip>
          {windowed ? (
            <Tip label={t.quick.closeTip}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void close()}
                aria-label={t.action.close}
                aria-keyshortcuts="Escape"
              >
                <X className="size-4" aria-hidden />
              </Button>
            </Tip>
          ) : null}
        </header>
        {strip}
        {/* On a phone, here under the header: the foot of the page is under the keyboard. */}
        {windowed ? null : statusLine}
      </div>

      <div
        ref={scroller}
        data-quick-pane=""
        // What is written scrolls here, not the page, which the page would
        // then chase. A tap below the last line goes to its end.
        className={cn("min-h-0 flex-1 overflow-y-auto", !windowed && "overscroll-contain")}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          editor.current?.focus(true);
        }}
        // On a phone, what is written last clears the home indicator.
        style={
          windowed || keyboard
            ? undefined
            : { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }
        }
      >
        {doc ? (
          <QuickEditor
            autoFocus
            doc={doc}
            handle={editor}
            onSave={onSave}
            images={quickImages}
            // The editor would take it to let go of the focus: the window goes, as from anywhere in it.
            onEscape={windowed ? onEscape : undefined}
            barSlot={windowed ? null : barSlot}
          />
        ) : null}
      </div>

      {windowed ? (
        // One line in the window's width: what was said, or else the keys.
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          {statusLine}
          {said ? null : <p>{t.quick.hint(modKey, true)}</p>}
        </div>
      ) : (
        <>
          {/* Keys a phone's keyboard does not have: not offered there. */}
          <p
            className="border-t px-4 py-2 text-xs text-muted-foreground pointer-coarse:hidden"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
          >
            {t.quick.hint(modKey, false)}
          </p>
          {/* With the keyboard up, the bar of block actions (a list's 字下げ and the rest). */}
          <div ref={setBarSlot} className="contents" />
        </>
      )}
    </main>
  );
}
