"use client";

import { ArrowLeft, Check, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n/ja";
import { useModKeyLabel } from "@/lib/platform";
import { appendParagraphs } from "@/lib/quick/body";
import { clearDraft, keepDraft, loadDraft } from "@/lib/quick/draft";
import { useQuickMode } from "@/lib/quick/mode";
import { closeQuickWindow, openNoteInApp } from "@/lib/quick/shell";
import { SHARED, joinShared, splitQuickText } from "@/lib/quick/text";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { createNote, renameNote } from "@/lib/sync/mutations";
import { bodyFragment } from "@/lib/sync/ydoc";
import { cn } from "@/lib/utils";

/** What the status line says: how the last save went, or that a draft came back. */
type Status =
  | { kind: "saved"; noteId: string }
  | { kind: "failed" }
  | { kind: "restored" }
  | { kind: "appended"; before: string }
  | null;

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
    <Capture
      key={me?.userKey ?? ""}
      userKey={me?.userKey ?? ""}
      inbox={me?.inboxFolderId ?? null}
      shared={shared}
    />
  );
}

function Capture({
  userKey,
  inbox,
  shared,
}: {
  userKey: string;
  inbox: string | null;
  shared: string;
}) {
  const router = useRouter();
  const windowed = useQuickMode() === "window";
  const modKey = useModKeyLabel();
  const [text, setText] = useState(shared);
  const textRef = useRef(shared);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = useRef<ReturnType<typeof keepDraft> | null>(null);
  /** A save under way, for closing to wait for. */
  const inFlight = useRef<Promise<void> | null>(null);
  /** The note a save made and could not finish, for the next save to finish. */
  const unfinished = useRef<string | null>(null);

  const show = (next: string) => {
    textRef.current = next;
    setText(next);
  };

  useEffect(() => {
    const kept = keepDraft(userKey);
    draft.current = kept;
    // What was shared is part of the draft from the start.
    if (shared) kept.update(shared);
    // A draft left from before comes back, said so on the status line: in the
    // empty field, or under what is there already (shared, or typed while it
    // was being read), so the first line is still the new one's.
    let current = true;
    void loadDraft(userKey)
      .then((left) => {
        if (!current) return;
        const now = textRef.current;
        if (!left || left.text.trim() === "" || now.includes(left.text)) return;
        if (now.trim() === "") {
          show(left.text);
          setStatus({ kind: "restored" });
        } else {
          show(`${now}\n\n${left.text}`);
          setStatus({ kind: "appended", before: now });
        }
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
    // Once for the account: a new one is a new Capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey]);

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

  /** Waits for a save under way, keeps what is written, and puts the window away. */
  const close = useCallback(async () => {
    await inFlight.current;
    await draft.current?.flush(true);
    // Shown again by the shell, the window should not still say saved.
    setStatus(null);
    closeQuickWindow();
  }, []);

  useEffect(() => {
    if (!windowed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || composing(event)) return;
      event.preventDefault();
      void close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [windowed, close]);

  const save = async () => {
    const { title, body } = splitQuickText(textRef.current);
    if ((title.length === 0 && body.length === 0) || saving) return;
    setSaving(true);
    setStatus(null);
    const run = (async () => {
      try {
        // The first line is the title, as long as it is short enough to be one.
        let noteId = unfinished.current;
        if (noteId) await renameNote(noteId, title);
        else noteId = await createNote({ folderId: inbox, title, kind: "quick" });
        unfinished.current = noteId;

        // The rest goes straight into the note's document, so the full editor
        // opens on exactly what was typed here: all of it, over whatever a
        // save that did not finish may have written.
        if (body.length > 0) {
          const doc = await acquireDoc(noteId);
          try {
            const fragment = bodyFragment(doc);
            if (fragment.length > 0) doc.transact(() => fragment.delete(0, fragment.length));
            appendParagraphs(doc, body);
          } finally {
            await releaseDoc(noteId);
          }
        }
        unfinished.current = null;

        draft.current?.cancel();
        // A draft left behind only comes back next time: not a failed save.
        await clearDraft(userKey).catch(() => undefined);
        if (windowed) {
          show("");
          setStatus({ kind: "saved", noteId });
          field.current?.focus();
        } else {
          router.replace(`/app?${new URLSearchParams({ n: noteId })}`);
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

  const undo = (next: string) => {
    show(next);
    setStatus(null);
    draft.current?.update(next);
    field.current?.focus();
  };

  const link = "text-foreground underline underline-offset-2";
  const said =
    status?.kind === "saved" ? (
      <>
        {t.quick.saved} ・{" "}
        <button type="button" className={link} onClick={() => openNoteInApp(status.noteId)}>
          {t.quick.openNote}
        </button>
      </>
    ) : status?.kind === "failed" ? (
      t.quick.failed
    ) : status?.kind === "restored" ? (
      <>
        {t.quick.restored} ・{" "}
        <button type="button" className={link} onClick={() => undo("")}>
          {t.quick.discard}
        </button>
      </>
    ) : status?.kind === "appended" ? (
      <>
        {t.quick.appended} ・{" "}
        <button type="button" className={link} onClick={() => undo(status.before)}>
          {t.quick.takeOut}
        </button>
      </>
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
      // A window keeps its size, and what is written scrolls inside the field;
      // a page grows with it, and scrolls as a whole.
      className={cn("flex flex-col", windowed ? "h-dvh" : "min-h-dvh")}
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div
        className={cn("border-b bg-background", !windowed && "sticky z-10")}
        style={windowed ? undefined : { top: "env(safe-area-inset-top, 0px)" }}
      >
        <header className="flex items-center gap-2 px-2 py-2">
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
          <h1 className={cn("flex-1 text-sm font-medium", windowed && "pl-2")}>{t.nav.quick}</h1>
          <Button
            size="sm"
            onClick={save}
            disabled={saving || text.trim().length === 0}
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
        {/* On a phone, here under the header: the foot of the page is under the keyboard. */}
        {windowed ? null : statusLine}
      </div>

      <Textarea
        ref={field}
        value={text}
        readOnly={saving}
        onChange={(event) => edit(event.target.value)}
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
        className="min-h-0 flex-1 resize-none rounded-none border-0 p-4 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

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
