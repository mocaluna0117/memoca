"use client";

import { ArrowLeft, Check, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n/ja";
import { useModKeyLabel } from "@/lib/platform";
import { appendParagraphs } from "@/lib/quick/body";
import { clearDraft, keepDraft, loadDraft } from "@/lib/quick/draft";
import { useQuickMode } from "@/lib/quick/mode";
import { closeQuickWindow, openInApp } from "@/lib/quick/shell";
import { joinShared, splitQuickText } from "@/lib/quick/text";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { createNote } from "@/lib/sync/mutations";
import { cn } from "@/lib/utils";

/** What the last save came to, said on the status line rather than in a toast. */
type Outcome = { kind: "saved"; noteId: string } | { kind: "failed" } | null;

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
 * as a draft on this device until it is saved.
 */
export function QuickCapture() {
  const router = useRouter();
  const params = useSearchParams();
  const { me } = useSync();
  const mode = useQuickMode();
  const modKey = useModKeyLabel();
  // Android's share sheet and the home-screen shortcut arrive with the text in
  // the query string, so the first render already has it.
  const shared = useMemo(
    () => joinShared({ title: params.get("title"), text: params.get("text"), url: params.get("url") }),
    [params],
  );
  const [text, setText] = useState(shared);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = useRef<ReturnType<typeof keepDraft> | null>(null);

  useEffect(() => {
    const kept = keepDraft();
    draft.current = kept;
    return () => {
      kept.dispose();
      draft.current = null;
    };
  }, []);

  // A draft left from before comes back, above anything just shared; not over
  // anything typed since the page opened.
  useEffect(() => {
    let current = true;
    void loadDraft().then((left) => {
      if (!current || !left) return;
      setText((now) => (now === shared ? [left.text, shared].filter(Boolean).join("\n\n") : now));
    });
    return () => {
      current = false;
    };
  }, [shared]);

  useEffect(() => {
    field.current?.focus();
    if (mode !== "window") return;
    // Shown again by the shell, or brought forward: ready to type into.
    const refocus = () => field.current?.focus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, [mode]);

  const edit = (next: string) => {
    setText(next);
    setOutcome(null);
    draft.current?.update(next);
  };

  const close = async () => {
    await draft.current?.flush();
    closeQuickWindow();
  };

  useEffect(() => {
    if (mode !== "window") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      void close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode]);

  const save = async () => {
    const { title, body } = splitQuickText(text);
    if ((title.length === 0 && body.length === 0) || saving) return;
    setSaving(true);
    setOutcome(null);
    try {
      // The first line is the title, as long as it is short enough to be one.
      const noteId = await createNote({ folderId: me?.inboxFolderId ?? null, title, kind: "quick" });

      // The rest goes straight into the note's document, so the full editor
      // opens on exactly what was typed here.
      if (body.length > 0) {
        const doc = await acquireDoc(noteId);
        appendParagraphs(doc, body);
        await releaseDoc(noteId);
      }

      draft.current?.cancel();
      await clearDraft();
      if (mode === "window") {
        setText("");
        setOutcome({ kind: "saved", noteId });
        field.current?.focus();
      } else {
        router.replace(`/app?n=${noteId}`);
      }
    } catch {
      // Kept as it is, draft and all, to be saved again.
      setOutcome({ kind: "failed" });
    } finally {
      setSaving(false);
    }
  };

  const windowed = mode === "window";
  return (
    <main
      // A window keeps its size, and what is written scrolls inside the field;
      // a page grows with it, and scrolls as a whole.
      className={cn("flex flex-col", windowed ? "h-dvh" : "min-h-dvh")}
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <header
        className={cn(
          "bg-background flex items-center gap-2 border-b px-2 py-2",
          // A page scrolls with what is written; its header stays in view.
          !windowed && "sticky top-0 z-10",
        )}
      >
        {windowed ? null : (
          <Button variant="ghost" size="icon" onClick={() => router.push("/app")} aria-label="戻る">
            <ArrowLeft className="size-5" aria-hidden />
          </Button>
        )}
        <h1 className={cn("flex-1 text-sm font-medium", windowed && "pl-2")}>{t.nav.quick}</h1>
        <Button size="sm" onClick={save} disabled={saving || text.trim().length === 0}>
          <Check className="size-4" aria-hidden />
          保存
        </Button>
        {windowed ? (
          <Button variant="ghost" size="icon" onClick={() => void close()} aria-label="閉じる">
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </header>

      <Textarea
        ref={field}
        value={text}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={(event) => {
          // An input method still choosing a word: its Enter is its own.
          if (event.nativeEvent.isComposing) return;
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
        placeholder="思いついたことをそのまま書いてください。短い 1 行目はタイトルになります。Inbox に入ります。"
        aria-label="即席メモ"
        className="min-h-0 flex-1 resize-none rounded-none border-0 p-4 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      <div
        className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-xs"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
      >
        <p>
          {modKey} + Enter で保存{windowed ? " ・ Esc で閉じる" : ""}
        </p>
        {/* Always in the page, even empty: a screen reader announces what comes
            into a region it already knows, not one that has just appeared. */}
        <p role="status" aria-live="polite">
          {outcome?.kind === "saved" ? (
            <>
              保存しました ・{" "}
              <button
                type="button"
                className="text-foreground underline underline-offset-2"
                onClick={() => openInApp(`/app?n=${outcome.noteId}`)}
              >
                エディタで開く
              </button>
            </>
          ) : outcome?.kind === "failed" ? (
            "保存できませんでした。もう一度お試しください。"
          ) : null}
        </p>
      </div>
    </main>
  );
}
