"use client";

import { ArrowLeft, Check } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n/ja";
import { appendParagraphs } from "@/lib/quick/body";
import { joinShared, splitQuickText } from "@/lib/quick/text";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { createNote } from "@/lib/sync/mutations";

/**
 * Write first, organise later.
 *
 * No folder to pick and no title to invent: whatever is typed lands in Inbox as
 * a normal note, so it can be moved, locked or edited in the full editor
 * afterwards. Android's share sheet and the home-screen shortcut both arrive
 * here with the text prefilled.
 */
export function QuickCapture() {
  const router = useRouter();
  const params = useSearchParams();
  const { me } = useSync();
  // Android's share sheet and the home-screen shortcut arrive with the text in
  // the query string, so the first render already has it.
  const shared = useMemo(
    () => joinShared({ title: params.get("title"), text: params.get("text"), url: params.get("url") }),
    [params],
  );
  const [text, setText] = useState(shared);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const save = async () => {
    const { title, body } = splitQuickText(text);
    if ((title.length === 0 && body.length === 0) || saving) return;
    setSaving(true);

    // The first line is the title, as long as it is short enough to be one.
    const noteId = await createNote({ folderId: me?.inboxFolderId ?? null, title, kind: "quick" });

    // The rest goes straight into the note's document, so the full editor
    // opens on exactly what was typed here.
    if (body.length > 0) {
      const doc = await acquireDoc(noteId);
      appendParagraphs(doc, body);
      await releaseDoc(noteId);
    }

    router.replace(`/app?n=${noteId}`);
  };

  return (
    <main
      className="flex min-h-dvh flex-col"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <header className="flex items-center gap-2 border-b px-2 py-2">
        <Button variant="ghost" size="icon" onClick={() => router.push("/app")} aria-label="戻る">
          <ArrowLeft className="size-5" aria-hidden />
        </Button>
        <h1 className="flex-1 text-sm font-medium">{t.nav.quick}</h1>
        <Button size="sm" onClick={save} disabled={saving || text.trim().length === 0}>
          <Check className="size-4" aria-hidden />
          保存
        </Button>
      </header>

      <Textarea
        ref={field}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void save();
        }}
        placeholder="思いついたことをそのまま書いてください。短い 1 行目はタイトルになります。Inbox に入ります。"
        aria-label="即席メモ"
        className="min-h-0 flex-1 resize-none rounded-none border-0 p-4 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      <p
        className="text-muted-foreground border-t px-4 py-2 text-xs"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
      >
        ⌘ + Enter で保存
      </p>
    </main>
  );
}
