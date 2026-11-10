"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import type { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { AppWindow, ArrowLeft, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ReactNode,
  type Ref,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import { imeCommit } from "@/components/editor/ime-commit";
import { listKeys } from "@/components/editor/list-keys";
import { DISABLED_EXTENSIONS } from "@/components/editor/quotes";
import { DICTIONARY, SCHEMA } from "@/components/editor/schema";
import { sortTodo, todoDue } from "@/components/editor/todo-due";
import { TODO_TIDY, lineAt, makeDetail, makeItem, todoOnly } from "@/components/editor/todo-only";
import { TodoDuePicker } from "@/components/notes/todo-due-picker";
import { TodoNotify, useSendReminders } from "@/components/notes/todo-notify";
import { Tip } from "@/components/notes/quick-tip";
import { Button } from "@/components/ui/button";
import { newBuildOut } from "@/lib/build";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { layoutHeight, useVisibleArea } from "@/lib/hooks/use-visible-area";
import { t } from "@/lib/i18n/ja";
import { openLinkApart } from "@/lib/open-link";
import { useModKeyLabel } from "@/lib/platform";
import { useQuickMode } from "@/lib/quick/mode";
import { SHELL_HIDDEN, closeQuickWindow } from "@/lib/quick/shell";
import { useSyncEngine, useSyncStatusStore } from "@/components/providers/sync-provider";
import { readyTodo } from "@/lib/quick/todo";
import { NONE, NOTIFY_MAP, type Timing, defaultTimings, entriesOf, ownTimings, writeTimings } from "@/lib/notify/reminders";
import { DUE_MAP, TODO_DUE } from "@/lib/quick/todo-due";
import { joinTodoLists } from "@/lib/quick/todo-repair";
import { acquireDoc, flushDoc, releaseDoc } from "@/lib/sync/docs";
import { ORIGIN, bodyFragment } from "@/lib/sync/ydoc";
import { cn } from "@/lib/utils";

/**
 * BlockNote's shortcuts that make a line something other than a Todo's
 * item (a heading of #, a list of -, a quote of >): left out, rather than
 * the line made that and then made an item again, the characters typed lost.
 * The tick box's own (Enter, [ ] ) are kept.
 */
const NOT_ITEMS = [
  ...DISABLED_EXTENSIONS,
  "heading-shortcuts",
  "bullet-list-item-shortcuts",
  "numbered-list-item-shortcuts",
  "toggle-list-item-shortcuts",
  "divider-block-shortcuts",
  "paragraph-shortcuts",
];

/** An input method still choosing a word: its keys are its own. */
const composing = (event: { isComposing: boolean; keyCode: number }) =>
  event.isComposing || event.keyCode === 229;

/** How many of a Todo's items are done, read from its document. */
function doneIn(doc: Y.Doc): number {
  let done = 0;
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "checkListItem") {
        const checked = child.getAttribute("checked") as unknown;
        if (checked === true || checked === "true") done += 1;
        continue;
      }
      walk(child);
    }
  };
  walk(bodyFragment(doc));
  return done;
}

/** What the Todo tab does with its editor. */
type TodoEditorHandle = {
  focus: () => void;
  /** Takes the done out of the list: undone by ⌘ + Z. */
  clearDone: () => void;
  /** The caret's line made a line of details (an item's), or an item (a detail's), as Tab and Shift + Tab do. */
  turnLine: () => void;
};

/** What the line the caret is in can be made, for the button that does it: null in none, or in the first item. */
type Turn = "toDetail" | "toItem" | null;

/**
 * The quick note's Todo tab: one list of the account's, synced as a note is
 * (lib/quick/todo), every line a tick box, the done at its foot, faded. No
 * save, no folder, no images: what is written is kept, and sent, as it is
 * written. Esc puts the window away, as in the other tabs.
 */
export function TodoCapture({
  strip,
  escapeEnabled,
}: {
  /** The tabs, under the header. */
  strip: ReactNode;
  /** Esc puts the window away: not while a dialog over it is open. */
  escapeEnabled: boolean;
}) {
  const router = useRouter();
  const windowed = useQuickMode() === "window";
  const canShowApp = useClientValue(() => typeof window.memocaShell?.showApp === "function", false);
  const modKey = useModKeyLabel();
  const area = useVisibleArea();
  const keyboard = !windowed && area !== null && area.height < layoutHeight() - 100;
  const [loaded, setLoaded] = useState<{ noteId: string; doc: Y.Doc } | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(0);
  const [turn, setTurn] = useState<Turn>(null);
  const editor = useRef<TodoEditorHandle>(null);
  const noteId = loaded?.noteId ?? null;
  const status = useSyncStatusStore();
  const engine = useSyncEngine();
  // Its reminders sent as it is changed here.
  useSendReminders(loaded?.doc ?? null);

  useEffect(() => {
    // Let go of exactly once, as the note editor does (see NoteEditor).
    let cancelled = false;
    let held: string | null = null;
    void readyTodo(status, engine, () => cancelled)
      .then(async (id) => {
        const doc = await acquireDoc(id);
        if (cancelled) {
          void releaseDoc(id);
          return;
        }
        held = id;
        // Two lists begun apart, put together before the editor shows it.
        joinTodoLists(doc);
        setDone(doneIn(doc));
        setLoaded({ noteId: id, doc });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (held) void releaseDoc(held);
    };
    // Once: the store and the engine's getter are the provider's, for good.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // How many are done, for the button that takes them out; and another
  // device's list, met here, put together with this one (joinTodoLists).
  useEffect(() => {
    if (!loaded) return;
    const body = bodyFragment(loaded.doc);
    const join = () => setTimeout(() => joinTodoLists(loaded.doc), 0);
    const changed = (_events: unknown, transaction: Y.Transaction) => {
      setDone(doneIn(loaded.doc));
      // A second list (counted at once), or something come from elsewhere
      // (an item there twice, as two devices put the lists together).
      if (body.length > 1 || transaction.origin === ORIGIN.remote || transaction.origin === ORIGIN.load) {
        join();
      }
    };
    body.observeDeep(changed);
    // One come in between its being read and this being listened for.
    join();
    return () => body.unobserveDeep(changed);
  }, [loaded]);

  /** Stores what is written, and puts the window away. */
  const close = useCallback(async () => {
    if (noteId) await flushDoc(noteId).catch(() => undefined);
    closeQuickWindow();
  }, [noteId]);
  const showApp = useCallback(async () => {
    if (noteId) await flushDoc(noteId).catch(() => undefined);
    window.memocaShell?.showApp?.();
  }, [noteId]);

  useEffect(() => {
    if (!windowed) return;
    // Put away by the desktop shell: stored, and a new version of the site
    // loaded out of sight (as the other tabs do).
    const hidden = async () => {
      if (noteId) await flushDoc(noteId).catch(() => undefined);
      if ((await newBuildOut()) && !document.hasFocus()) window.location.reload();
    };
    window.addEventListener(SHELL_HIDDEN, hidden);
    return () => window.removeEventListener(SHELL_HIDDEN, hidden);
  }, [windowed, noteId]);

  useEffect(() => {
    if (!windowed) return;
    // Esc from outside the editor (a button has the focus): the window goes.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || composing(event) || event.defaultPrevented || !escapeEnabled)
        return;
      event.preventDefault();
      void close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [windowed, close, escapeEnabled]);

  useEffect(() => {
    if (!loaded || !windowed) return;
    // Shown again by the shell, or brought forward: ready to type into.
    const refocus = () => editor.current?.focus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, [loaded, windowed]);

  const latest = useRef({ escape: () => {} });
  useLayoutEffect(() => {
    latest.current.escape = () => {
      if (escapeEnabled) void close();
    };
  });
  const onEscape = useCallback(() => latest.current.escape(), []);

  return (
    <main
      className={cn("flex flex-col", windowed ? "h-dvh" : "fixed inset-x-0 top-0 h-dvh")}
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        ...(windowed || !area
          ? {}
          : { height: area.height, transform: area.top ? `translateY(${area.top}px)` : undefined }),
      }}
    >
      <div className="border-b bg-background">
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
          {loaded ? <TodoNotify doc={loaded.doc} /> : null}
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
      </div>

      <div
        data-quick-pane=""
        className={cn("min-h-0 flex-1 overflow-y-auto", !windowed && "overscroll-contain")}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          editor.current?.focus();
        }}
        style={
          windowed || keyboard
            ? undefined
            : { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }
        }
      >
        {loaded ? (
          <TodoEditor
            doc={loaded.doc}
            handle={editor}
            onEscape={windowed ? onEscape : undefined}
            onTurn={setTurn}
          />
        ) : failed ? (
          <p role="alert" className="px-4 py-6 text-sm text-muted-foreground">
            {t.quick.todoFailed}
          </p>
        ) : (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t.quick.todoLoading}
          </p>
        )}
      </div>

      <div
        className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground"
        style={
          windowed
            ? undefined
            : { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }
        }
      >
        <p className="min-w-0 flex-1 truncate pointer-coarse:hidden">
          {t.quick.todoHint(modKey, windowed)}
        </p>
        {/* On a phone, with no Tab: the caret's line made a detail, or an item. */}
        {turn ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs pointer-fine:hidden"
            // The caret stays in the editor, and the keyboard up.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.current?.turnLine()}
          >
            {turn === "toDetail" ? t.quick.toDetail : t.quick.toItem}
          </Button>
        ) : null}
        {done > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 shrink-0 px-2 text-xs"
            onClick={() => editor.current?.clearDone()}
          >
            {t.quick.clearDone(done)}
          </Button>
        ) : null}
      </div>
    </main>
  );
}

/**
 * The Todo's editor: a note's, on the Todo's own note, every block a tick
 * box (todo-only), with nothing else of the note's editor: no menu of
 * blocks, no toolbar, no + or handle, no files.
 */
const TodoEditor = memo(function TodoEditor({
  doc,
  handle,
  onEscape,
  onTurn,
}: {
  doc: Y.Doc;
  handle: Ref<TodoEditorHandle>;
  /** Esc: none, the editor's own. */
  onEscape?: () => void;
  /** What the caret's line can be made, told as the caret moves. */
  onTurn: (turn: Turn) => void;
}) {
  const { resolvedTheme } = useTheme();
  const dues = useMemo(() => doc.getMap<string>(DUE_MAP), [doc]);
  const notify = useMemo(() => doc.getMap<string>(NOTIFY_MAP), [doc]);
  // The item whose due is being picked, and where its button is.
  const [picking, setPicking] = useState<{ id: string; at: DOMRect } | null>(null);
  const options = useMemo(
    () =>
      withCollaboration({
        collaboration: { fragment: bodyFragment(doc), user: { name: "自分", color: "#0ea5e9" } },
        schema: SCHEMA,
        dictionary: {
          ...DICTIONARY,
          placeholders: {
            ...DICTIONARY.placeholders,
            emptyDocument: t.quick.todoPlaceholder,
            checkListItem: t.quick.todoItemPlaceholder,
            // Every other line is a line of an item's details.
            default: t.quick.todoDetailPlaceholder,
          },
        },
        animations: false,
        trailingBlock: false,
        links: { onClick: (event: MouseEvent) => openLinkApart(event) },
        disableExtensions: NOT_ITEMS,
        extensions: [
          todoOnly(),
          listKeys(),
          imeCommit(),
          todoDue({ map: doc.getMap<string>(DUE_MAP), onPick: (id, at) => setPicking({ id, at }) }),
        ],
        domAttributes: { editor: { "aria-label": t.quick.todoField } },
        // Files have nowhere to go in a Todo; text pasted becomes its items.
        pasteHandler: ({ event, defaultPasteHandler }) => {
          const data = event.clipboardData;
          if (data && data.files.length > 0 && !data.types.includes("text/plain")) return true;
          return defaultPasteHandler();
        },
      }),
    [doc],
  );
  const editor = useCreateBlockNote(options, [doc]);
  const plain = editor as unknown as BlockNoteEditor;

  /** The caret after the last item to do (or in the first item, if all are done). */
  const toEnd = useCallback(() => {
    const blocks = plain.document;
    const todo = blocks.filter(
      (block) =>
        !(block.type === "checkListItem" && (block.props as { checked?: boolean }).checked),
    );
    const target = todo.at(-1) ?? blocks[0];
    if (target) {
      try {
        plain.setTextCursorPosition(target, "end");
      } catch {
        // Not a line of text: left where it is.
      }
    }
    plain.focus();
  }, [plain]);

  useImperativeHandle(
    handle,
    () => ({
      focus: () => plain.focus(),
      clearDone: () => {
        const finished = plain.document.filter(
          (block) =>
            block.type === "checkListItem" && (block.props as { checked?: boolean }).checked,
        );
        if (finished.length > 0) plain.removeBlocks(finished);
        // Their dues go with them, and their reminders' times.
        doc.transact(() => {
          for (const block of finished) {
            dues.delete(block.id);
            notify.delete(block.id);
          }
        }, TODO_DUE);
        toEnd();
      },
      turnLine: () => {
        const view = plain.prosemirrorView;
        if (!view) return;
        const tr = makeDetail(view.state) ?? makeItem(view.state);
        if (tr) view.dispatch(tr);
      },
    }),
    [plain, toEnd, doc, dues, notify],
  );

  useEffect(() => {
    // On a phone, the keyboard down as the picker opens: it has the screen.
    if (picking && window.matchMedia("(pointer: coarse)").matches) plain.prosemirrorView?.dom.blur();
  }, [picking, plain]);
  const pickedDue = useCallback(
    (due: string | null) => {
      if (!picking) return;
      doc.transact(() => {
        if (due) dues.set(picking.id, due);
        else {
          dues.delete(picking.id);
          // No due, nothing to be told of: the account's times again, if one is given later.
          notify.delete(picking.id);
        }
      }, TODO_DUE);
    },
    [doc, dues, notify, picking],
  );
  const pickedNotify = useCallback(
    (own: Timing[] | typeof NONE | null) => {
      if (!picking) return;
      doc.transact(() => {
        if (own === null) notify.delete(picking.id);
        else notify.set(picking.id, own === NONE || own.length === 0 ? NONE : writeTimings(own));
      }, TODO_DUE);
    },
    [doc, notify, picking],
  );
  const pickerClosed = useCallback(() => {
    setPicking(null);
    // In order of the dues, now that it is put away (not under it as it moved).
    const view = plain.prosemirrorView;
    if (view) sortTodo(view, dues);
    if (!window.matchMedia("(pointer: coarse)").matches) plain.focus();
  }, [plain, dues]);

  useEffect(() => {
    // What the caret's line can be made, for the button on a phone.
    const tell = () => {
      const view = plain.prosemirrorView;
      const line = view && view.hasFocus() ? lineAt(view.state) : null;
      onTurn(!line ? null : line.kind === "detail" ? "toItem" : line.index > 0 ? "toDetail" : null);
    };
    tell();
    const off = plain.onSelectionChange(tell);
    // A line made a detail may leave the caret at the same place by number,
    // which is no change of the selection to BlockNote.
    const offChange = plain.onChange(tell);
    const dom = plain.prosemirrorView?.dom;
    dom?.addEventListener("focus", tell);
    dom?.addEventListener("blur", tell);
    return () => {
      off?.();
      offChange?.();
      dom?.removeEventListener("focus", tell);
      dom?.removeEventListener("blur", tell);
    };
  }, [plain, onTurn]);

  useEffect(() => {
    // Its blocks put right as it is shown (the editor's own first, empty line
    // made an item), and ready to type into, after what is still to do.
    const view = plain.prosemirrorView;
    view?.dispatch(view.state.tr.setMeta(TODO_TIDY, true));
    toEnd();
  }, [plain, toEnd]);

  return (
    <div
      onKeyDownCapture={(event) => {
        const native = event.nativeEvent;
        if (composing(native)) return;
        // Where the caret is in the page now, before a key that acts at it:
        // one moved by a click or by ⌘ + →, just before, may not have reached
        // the editor yet (selectionchange comes after), and Enter would split
        // the item where the caret was.
        if (event.key === "Enter" || event.key === "Backspace" || event.key === "Delete" || event.key === "Tab") {
          const view = plain.prosemirrorView as unknown as { domObserver?: { flush?: () => void } } | undefined;
          view?.domObserver?.flush?.();
        }
        if (event.key === "Escape" && onEscape) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
      onDragOverCapture={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDropCapture={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <BlockNoteView
        editor={editor}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        className="memoca-editor memoca-quick-editor memoca-todo"
        formattingToolbar={false}
        slashMenu={false}
        sideMenu={false}
        // Its menu opens on ":" (a URL's "https:" too), and takes the next
        // Enter to close itself: the line would not end.
        emojiPicker={false}
      />
      {picking ? (
        <TodoDuePicker
          due={dues.get(picking.id) ?? null}
          at={picking.at}
          onPick={pickedDue}
          onClose={pickerClosed}
          notify={ownTimings(entriesOf(notify), picking.id)}
          defaults={defaultTimings(entriesOf(notify))}
          onNotify={pickedNotify}
        />
      ) : null}
    </div>
  );
});
