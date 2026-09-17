"use client";

import { ArrowLeft, Check } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { useSync } from "@/components/providers/sync-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { createNote } from "@/lib/sync/mutations";
import { bodyFragment, firstLine } from "@/lib/sync/ydoc";
import { t } from "@/lib/i18n/ja";

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
    () =>
      [params.get("title"), params.get("text"), params.get("url")]
        .filter((part): part is string => Boolean(part))
        .join("\n"),
    [params],
  );
  const [text, setText] = useState(shared);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const save = async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || saving) return;
    setSaving(true);

    const noteId = await createNote({
      folderId: me?.inboxFolderId ?? null,
      title: firstLine(trimmed, 80),
      kind: "quick",
    });

    // Write the text straight into the note's document, so the full editor
    // opens on exactly what was typed here.
    const doc = await acquireDoc(noteId);
    const fragment = bodyFragment(doc);
    doc.transact(() => {
      for (const line of trimmed.split("\n")) {
        const paragraph = new Y.XmlElement("paragraph");
        const content = new Y.XmlText();
        if (line.length > 0) content.insert(0, line);
        paragraph.insert(0, [content]);
        fragment.push([paragraph]);
      }
    });
    await releaseDoc(noteId);

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
        placeholder="思いついたことをそのまま書いてください。Inbox に入ります。"
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
