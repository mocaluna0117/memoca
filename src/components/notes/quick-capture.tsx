"use client";

import { AppWindow, ArrowLeft, Check, ImagePlus, X } from "lucide-react";
import { uuidv7 } from "uuidv7";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { newBuildOut } from "@/lib/build";
import { t } from "@/lib/i18n/ja";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { useVisibleArea } from "@/lib/hooks/use-visible-area";
import { useModKeyLabel } from "@/lib/platform";
import { type Allowance, prepareUpload, stageUpload } from "@/lib/media/attachments";
import { uploadRefusal } from "@/lib/media/refusal";
import { type QuickPart, appendBlocks } from "@/lib/quick/body";
import {
  type DraftImage,
  MAX_TABS,
  clearDraft,
  closeTab,
  keepDraft,
  loadDraft,
  loadTabs,
  openTab,
  showTab,
  useQuickTabs,
} from "@/lib/quick/draft";
import { CloseTabDialog, type QuickTab, QuickTabs, holds, tabName } from "@/components/notes/quick-tabs";
import { useQuickMode } from "@/lib/quick/mode";
import { SHELL_HIDDEN, closeQuickWindow, inShell, openNoteInApp } from "@/lib/quick/shell";
import { SHARED, joinShared, quickLines } from "@/lib/quick/text";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { createNote } from "@/lib/sync/mutations";
import { bodyFragment } from "@/lib/sync/ydoc";
import { cn } from "@/lib/utils";

/** What the status line says: how the last save went, or why a file was turned away. */
type Status =
  | { kind: "saved"; noteId: string }
  | { kind: "failed" }
  /** A file turned away, and why. */
  | { kind: "refused"; message: string }
  | null;

/** What a tab's quick note does for the tabs around it. */
type CaptureHandle = {
  /** Saves it, as its button does. */
  save: () => Promise<void>;
  /** Lets go of what is written, its draft not written again as it goes. */
  discard: () => void;
};

/** An image added, with a URL of this tab's to show it by. */
type QuickImage = DraftImage & { url: string };

/** The most images one quick note takes. */
const MAX_IMAGES = 10;

/** Whether a file is an image, or one a phone sends as a HEIC photo with no type. */
const isImage = (file: File) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);

/** An image of the draft, shown again. */
const shown = (image: DraftImage): QuickImage => ({ ...image, url: URL.createObjectURL(image.blob) });
/** An image as the draft keeps it, its URL left out. */
const keptImage = (image: QuickImage): DraftImage => ({
  key: image.key,
  name: image.name,
  blob: image.blob,
  mime: image.mime,
  width: image.width,
  height: image.height,
});

/** Both keys the save is on, for whatever keyboard: ⌘ on a Mac, Ctrl elsewhere. */
const SAVE_KEYS = "Meta+Enter Control+Enter";

/** An input method still choosing a word: its keys are its own, Safari's too. */
const composing = (event: { isComposing: boolean; keyCode: number }) =>
  event.isComposing || event.keyCode === 229;

/**
 * Write first, organise later.
 *
 * No folder to pick and no title to invent: whatever is typed lands in Inbox as
 * a normal note, so it can be moved, locked or edited in the full editor
 * afterwards. Android's share sheet and the home-screen shortcut both arrive
 * here with the text prefilled.
 *
 * As a page (a phone), a save opens the note. As a window of its own (the
 * desktop shell, or a window the web app opens), it stays, emptied for the
 * next one, and Esc puts it away. Either way what is being written is kept
 * as a draft on this device, for this account, until it is saved.
 *
 * In tabs, as a text editor's: each a draft of its own. A tab saved is
 * closed (the last one stays, emptied); one closed with something in it is
 * asked about first.
 */
export function QuickCapture() {
  const { me } = useSync();
  const params = useSearchParams();
  // Android's share sheet and the home-screen shortcut arrive with the text in
  // the query string, so the first render already has it. Read once, it
  // leaves the address: the page loaded again would add it a second time.
  const [shared] = useState(() =>
    joinShared({ title: params.get("title"), text: params.get("text"), url: params.get("url") }),
  );
  useEffect(() => {
    if (!SHARED.some((name) => params.has(name))) return;
    const address = new URL(window.location.href);
    for (const name of SHARED) address.searchParams.delete(name);
    window.history.replaceState(null, "", address.pathname + address.search);
    // Once: what the address held is read on the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Another account signed in on this device starts afresh: no draft of the
  // last one's, nor anything typed while it was shown, is carried over. What
  // was shared is, being the one at the device's.
  return (
    <Tabbed
      key={me?.userKey ?? ""}
      userKey={me?.userKey ?? ""}
      inbox={me?.inboxFolderId ?? null}
      allowance={me ?? null}
      shared={shared}
    />
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
}: {
  userKey: string;
  inbox: string | null;
  allowance: Allowance | null;
  shared: string;
}) {
  const live = useQuickTabs(userKey);
  // What was shared, and the tab it goes into, until another tab is shown:
  // read by that tab's quick note as it starts, never again.
  const [share, setShare] = useState<{ tab: string; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let current = true;
    void (async () => {
      const tabs = await loadTabs(userKey);
      if (shared) {
        const there = await loadDraft(userKey, tabs.active);
        // Into the tab shown if it is empty (or holds it already).
        const busy = there && there.text.trim() !== "" && !there.text.includes(shared);
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
  // The tab shown's text as typed, before its draft is written.
  const [typed, setTyped] = useState<QuickTab | null>(null);
  // Said by the next tab shown, once one is saved and closed.
  const [notice, setNotice] = useState<Status>(null);
  // The tab asked about before it is closed.
  const [closing, setClosing] = useState<string | null>(null);

  const active = live?.tabs.active ?? null;
  const tabs: QuickTab[] = (live?.tabs.ids ?? []).map((id) => {
    if (typed?.id === id) return typed;
    const draft = live?.drafts.get(id);
    return { id, text: draft?.text ?? "", images: draft?.images?.length ?? 0 };
  });

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
  /** Closes a tab: at once if there is nothing in it, asked about first if there is. */
  const close = async (id: string) => {
    const tab = tabs.find((each) => each.id === id);
    if (!tab || tabs.length < 2) return;
    if (!holds(tab)) {
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
  /** A tab saved: closed, if it is not the last, the next one shown saying so. */
  const saved = async (noteId: string, tabId: string) => {
    // As they are now: the tabs read as this render's may be a moment behind.
    if ((await loadTabs(userKey)).ids.length < 2) return false;
    moving();
    setNotice({ kind: "saved", noteId });
    await closeTab(userKey, tabId);
    return true;
  };

  // In the desktop shell, a text editor's keys: a browser keeps them to itself.
  useEffect(() => {
    if (!inShell()) return;
    const onKey = (event: KeyboardEvent) => {
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
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!ready || !live || !active) return null;
  const asked = closing ? tabs.find((tab) => tab.id === closing) : undefined;
  return (
    <>
      <Capture
        key={active}
        handle={capture}
        tabId={active}
        userKey={userKey}
        inbox={inbox}
        allowance={allowance}
        shared={share?.tab === active ? share.text : ""}
        initialStatus={notice}
        escapeEnabled={closing === null}
        onText={(text, images) => setTyped({ id: active, text, images })}
        onSaved={(noteId) => saved(noteId, active)}
        strip={
          <QuickTabs
            tabs={tabs}
            active={active}
            canOpen={tabs.length < MAX_TABS}
            onShow={show}
            onOpen={open}
            onClose={(id) => void close(id)}
          />
        }
      />
      <CloseTabDialog
        name={asked ? tabName(asked) : ""}
        open={asked !== undefined}
        onCancel={() => setClosing(null)}
        onSave={() => {
          setClosing(null);
          void capture.current?.save();
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
    </>
  );
}

function Capture({
  handle,
  tabId,
  userKey,
  inbox,
  allowance,
  shared,
  initialStatus,
  escapeEnabled,
  onText,
  onSaved,
  strip,
}: {
  handle: Ref<CaptureHandle>;
  /** The tab this is: whose draft it keeps. */
  tabId: string;
  userKey: string;
  inbox: string | null;
  /** The account's figures, for an image to be checked against before it is added. */
  allowance: Allowance | null;
  shared: string;
  /** What the status line says first: that the tab before it was saved. */
  initialStatus: Status;
  /** Esc puts the window away: not while a dialog over it is open. */
  escapeEnabled: boolean;
  /** What it holds, as typed. */
  onText: (text: string, images: number) => void;
  /** Saved: whether the tab was closed for it. */
  onSaved: (noteId: string) => Promise<boolean>;
  /** The tabs, under the header. */
  strip: ReactNode;
}) {
  const router = useRouter();
  const windowed = useQuickMode() === "window";
  // The desktop shell's window for the whole app, to be brought out from
  // here: not in shells before 0.4.1.
  const canShowApp = useClientValue(() => typeof window.memocaShell?.showApp === "function", false);
  const modKey = useModKeyLabel();
  const area = useVisibleArea();
  const [text, setText] = useState(shared);
  const textRef = useRef(shared);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(initialStatus);
  const field = useRef<HTMLTextAreaElement>(null);
  // iOS pans what is seen down to the caret as its keyboard comes up, and the
  // page, kept to what is seen, takes back just as much, the caret's line
  // going with it, under the keyboard: the field is scrolled by the same, so
  // the line tapped on stays where iOS put it. The pan back as the keyboard
  // goes is not followed: the text stays where it is on the screen.
  const lastTop = useRef(0);
  useLayoutEffect(() => {
    // Zoomed in (no area), the page is left where it is, and so is this.
    if (windowed || !area) return;
    const moved = area.top - lastTop.current;
    lastTop.current = area.top;
    const element = field.current;
    if (moved > 0 && element && document.activeElement === element) element.scrollTop += moved;
  }, [windowed, area]);
  // With a keyboard up the home indicator is under it: nothing to clear. (The
  // root's height is the layout viewport's, which neither iOS's keyboard nor
  // Chrome's, resizing only what is seen, makes shorter.)
  const keyboard =
    !windowed && area !== null && area.height < document.documentElement.clientHeight - 100;
  const draft = useRef<ReturnType<typeof keepDraft> | null>(null);
  /** A save under way, for closing to wait for. */
  const inFlight = useRef<Promise<void> | null>(null);
  /** The note a save made and could not finish, for the next save to finish. */
  const unfinished = useRef<string | null>(null);

  const show = (next: string) => {
    textRef.current = next;
    setText(next);
    onText(next, imagesRef.current.length);
  };

  // Images added, each with a URL of this tab's to show it by, let go of
  // once it is gone (removed, saved, or the page left).
  const [images, setImages] = useState<QuickImage[]>([]);
  const imagesRef = useRef<QuickImage[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  /** The images a save staged already, by key: one tried again stages none twice. */
  const staged = useRef(new Map<string, string>());
  const showImages = (next: QuickImage[]) => {
    for (const image of imagesRef.current) {
      if (!next.includes(image)) URL.revokeObjectURL(image.url);
    }
    imagesRef.current = next;
    setImages(next);
    onText(textRef.current, next.length);
  };
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.url);
    },
    [],
  );

  useEffect(() => {
    const kept = keepDraft(userKey, tabId);
    draft.current = kept;
    // What was shared is part of the draft from the start.
    if (shared) kept.update(shared);
    // The tab's draft: in the empty field, or under what is there already
    // (typed while it was being read), so the first line is still the new one's.
    let current = true;
    void loadDraft(userKey, tabId)
      .then((left) => {
        if (!current) return;
        const now = textRef.current;
        // Its images, under any added meanwhile.
        const pictures = (left?.images ?? []).map(shown);
        if (pictures.length > 0) {
          showImages([...imagesRef.current, ...pictures]);
          kept.images(imagesRef.current.map(keptImage));
        }
        if (!left || left.text.trim() === "" || now.includes(left.text)) return;
        show(now.trim() === "" ? left.text : `${now}\n\n${left.text}`);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!current) return;
        kept.update(textRef.current);
        kept.release();
      });
    return () => {
      current = false;
      kept.dispose();
      draft.current = null;
    };
    // Once for the tab: another is a new Capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey, tabId]);

  useEffect(() => {
    field.current?.focus();
    if (!windowed) return;
    // Shown again by the shell, or brought forward: ready to type into.
    const refocus = () => field.current?.focus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, [windowed]);

  const edit = (next: string) => {
    show(next);
    setStatus(null);
    draft.current?.update(next);
  };

  const editImages = (next: QuickImage[]) => {
    showImages(next);
    setStatus(null);
    draft.current?.images(next.map(keptImage));
  };

  /**
   * Adds files as images, each made ready (compressed) and checked as one
   * added to a note is; one that cannot be is said so, the others added.
   */
  const addFiles = async (files: File[]) => {
    for (const file of files) {
      if (!isImage(file)) {
        setStatus({ kind: "refused", message: t.quick.imagesOnly });
        continue;
      }
      if (imagesRef.current.length >= MAX_IMAGES) {
        setStatus({ kind: "refused", message: t.quick.tooManyImages(MAX_IMAGES) });
        return;
      }
      try {
        const prepared = await prepareUpload(file, allowance);
        editImages([
          ...imagesRef.current,
          shown({
            key: uuidv7(),
            name: file.name || "image",
            blob: prepared.blob,
            mime: prepared.mime,
            width: prepared.width,
            height: prepared.height,
          }),
        ]);
      } catch (error) {
        setStatus({ kind: "refused", message: uploadRefusal(error) });
      }
    }
  };

  /** Waits for a save under way, keeps what is written, and puts the window away. */
  const close = useCallback(async () => {
    await inFlight.current;
    await draft.current?.flush(true);
    // Shown again by the shell, the window should not still say saved.
    setStatus(null);
    closeQuickWindow();
  }, []);

  /** As {@link close}, Memoca's own window brought out in its place, as it was left. */
  const showApp = useCallback(async () => {
    await inFlight.current;
    await draft.current?.flush(true);
    setStatus(null);
    window.memocaShell?.showApp?.();
  }, []);

  useEffect(() => {
    if (!windowed) return;
    // Put away by the desktop shell, which keeps the window loaded: what is
    // written is kept, and a new version of the site is loaded out of sight
    // (nothing else would ever load this page again).
    const hidden = async () => {
      await inFlight.current;
      await draft.current?.flush(true);
      setStatus(null);
      // Out again by the time the server says (and maybe being typed in):
      // left for the next time it is put away.
      if ((await newBuildOut()) && !document.hasFocus()) window.location.reload();
    };
    window.addEventListener(SHELL_HIDDEN, hidden);
    return () => window.removeEventListener(SHELL_HIDDEN, hidden);
  }, [windowed]);

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

  const save = async () => {
    const body = quickLines(textRef.current);
    const pictures = imagesRef.current;
    if ((body.length === 0 && pictures.length === 0) || saving) return;
    setSaving(true);
    setStatus(null);
    const run = (async () => {
      try {
        // No title: its first line stands in for one where notes are listed.
        const noteId =
          unfinished.current ?? (await createNote({ folderId: inbox, title: "", kind: "quick" }));
        unfinished.current = noteId;

        // All of it goes straight into the note's document, so the full editor
        // opens on exactly what was typed here, over whatever a save that did
        // not finish may have written.
        // Its images under its lines, each staged to go up as one added to a
        // note is (offline too), into the note made for them.
        const parts: QuickPart[] = body.map((text) => ({ kind: "line", text }));
        for (const image of pictures) {
          let ref = staged.current.get(image.key);
          if (!ref) {
            ref = await stageUpload({
              noteId,
              file: new File([image.blob], image.name, { type: image.mime }),
              prepared: { blob: image.blob, mime: image.mime, width: image.width, height: image.height },
            });
            staged.current.set(image.key, ref);
          }
          parts.push({ kind: "image", url: ref, name: image.name });
        }
        const doc = await acquireDoc(noteId);
        try {
          const fragment = bodyFragment(doc);
          if (fragment.length > 0) doc.transact(() => fragment.delete(0, fragment.length));
          appendBlocks(doc, parts);
        } finally {
          await releaseDoc(noteId);
        }
        unfinished.current = null;
        staged.current.clear();

        draft.current?.cancel();
        // A draft left behind only comes back next time: not a failed save.
        await clearDraft(userKey, tabId).catch(() => undefined);
        showImages([]);
        // Closed, if there are other tabs: the next one says it was saved.
        const closed = await onSaved(noteId);
        if (!windowed) {
          router.replace(`/app?${new URLSearchParams({ n: noteId })}`);
        } else if (!closed) {
          show("");
          setStatus({ kind: "saved", noteId });
          field.current?.focus();
        }
      } catch {
        // Kept as it is, draft and all, to be saved again: into the note
        // already made, if one was.
        setStatus({ kind: "failed" });
      } finally {
        setSaving(false);
      }
    })();
    inFlight.current = run;
    await run;
    if (inFlight.current === run) inFlight.current = null;
  };

  useImperativeHandle(handle, () => ({
    save,
    discard: () => draft.current?.cancel(),
  }));

  const link = "text-foreground underline underline-offset-2";
  const said =
    status?.kind === "saved" ? (
      <>
        {t.quick.saved} ・{" "}
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

  return (
    <main
      // What is written scrolls inside the field, and the header, its save
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
          className="flex items-center gap-2 px-2 py-2"
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
            className={cn("flex-1 text-sm font-medium", windowed && "pl-2 select-none")}
            data-tauri-drag-region={windowed || undefined}
          >
            {t.nav.quick}
          </h1>
          {canShowApp ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void showApp()}
              title={t.quick.openApp}
              aria-label={t.quick.openApp}
            >
              <AppWindow className="size-4" aria-hidden />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => picker.current?.click()}
            disabled={saving}
            aria-label={t.quick.addImage}
          >
            <ImagePlus className="size-4" aria-hidden />
          </Button>
          <input
            ref={picker}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              void addFiles(files);
            }}
          />
          <Button
            size="sm"
            onClick={save}
            disabled={saving || (text.trim().length === 0 && images.length === 0)}
            aria-keyshortcuts={SAVE_KEYS}
          >
            <Check className="size-4" aria-hidden />
            {t.action.save}
          </Button>
          {windowed ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void close()}
              aria-label={t.action.close}
              aria-keyshortcuts="Escape"
            >
              <X className="size-4" aria-hidden />
            </Button>
          ) : null}
        </header>
        {strip}
        {/* On a phone, here under the header: the foot of the page is under the keyboard. */}
        {windowed ? null : statusLine}
      </div>

      <Textarea
        ref={field}
        value={text}
        readOnly={saving}
        onChange={(event) => edit(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          // Text that comes with them (an image copied from a page) is pasted as text too.
          if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
          void addFiles(files);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = [...event.dataTransfer.files];
          if (files.length === 0) return;
          event.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(event) => {
          if (composing(event.nativeEvent)) return;
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
        placeholder={t.quick.placeholder}
        aria-label={t.quick.field}
        aria-keyshortcuts={SAVE_KEYS}
        // 16px at every width: under 16px (md:text-sm, an iPhone on its side)
        // iOS zooms in on focus, and zoomed in the page is not kept in sight.
        // What is scrolled to its end stays in the field rather than moving
        // the page, which the page would then chase.
        className={cn(
          "min-h-0 flex-1 resize-none rounded-none border-0 p-4 text-base shadow-none field-sizing-fixed focus-visible:ring-0 dark:bg-transparent",
          !windowed && "overscroll-contain md:text-base",
        )}
        // On a phone, what is written last clears the home indicator.
        style={
          windowed || keyboard
            ? undefined
            : { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }
        }
      />

      {images.length > 0 ? (
        <ul aria-label={t.quick.images} className="flex shrink-0 gap-2 overflow-x-auto border-t px-4 py-2">
          {images.map((image) => (
            <li key={image.key} className="relative shrink-0 pt-1.5 pr-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- a URL of this tab's */}
              <img src={image.url} alt={image.name} className="size-14 rounded-md border object-cover" />
              <button
                type="button"
                aria-label={t.quick.removeImage(image.name)}
                className="absolute top-0 right-0 flex size-5 items-center justify-center rounded-full bg-foreground text-background"
                onClick={() => editImages(imagesRef.current.filter((each) => each.key !== image.key))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {windowed ? (
        // One line in the window's width: what was said, or else the keys.
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          {statusLine}
          {said ? null : <p>{t.quick.hint(modKey, true)}</p>}
        </div>
      ) : (
        // Keys a phone's keyboard does not have: not offered there.
        <p
          className="border-t px-4 py-2 text-xs text-muted-foreground pointer-coarse:hidden"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
        >
          {t.quick.hint(modKey, false)}
        </p>
      )}
    </main>
  );
}
