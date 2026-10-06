"use client";

import { Languages, Loader2, Lock, Search as SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { MobileHeader } from "@/components/shell/app-shell";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { useSearch } from "@/lib/hooks/use-search";
import { useYomi } from "@/lib/hooks/use-yomi";
import { lockedSearchNote } from "@/lib/search/rows";
import { isKanaQuery } from "@/lib/search/yomi";
import { requestVault } from "@/lib/store/vault-gate";
import type { SearchHit } from "@/lib/search/engine";
import { t } from "@/lib/i18n/ja";
import { NoteName } from "@/components/search/note-name";

function Highlighted({ snippet }: { snippet: SearchHit["snippet"] }) {
  if (snippet.highlights.length === 0) return <>{snippet.text}</>;
  const pieces: React.ReactNode[] = [];
  let at = 0;
  const ordered = [...snippet.highlights].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of ordered) {
    if (start < at) continue;
    if (start > at) pieces.push(snippet.text.slice(at, start));
    pieces.push(
      <mark key={`${start}-${end}`} className="bg-primary/20 rounded-sm px-0.5 text-inherit">
        {snippet.text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < snippet.text.length) pieces.push(snippet.text.slice(at));
  return <>{pieces}</>;
}

export default function SearchPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const { hits, total, locked } = useSearch(query);
  const yomi = useYomi();
  const lockedNote = lockedSearchNote(locked);
  const kana = isKanaQuery(query);

  const turnOn = async () => {
    try {
      await yomi.turnOn();
    } catch (cause) {
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      toast.error(
        offline
          ? "オフラインのため、辞書をダウンロードできませんでした。インターネットにつないで、もう一度お試しください。"
          : `辞書を読み込めませんでした。もう一度お試しください。（${cause instanceof Error ? cause.message : String(cause)}）`,
      );
    }
  };

  // What the switch is doing, said under the field: only while it matters.
  const status = yomi.busy
    ? yomi.progress && yomi.progress.total > 0
      ? `読みを調べています… ${yomi.progress.done} / ${yomi.progress.total}`
      : "辞書（11MB）をダウンロードしています…"
    : yomi.on
      ? null
      : kana && hits.length === 0
        ? "「読みでも探す」をオンにすると、「やっきょく」で「薬局」のような漢字のメモも見つかります。辞書（11MB）のダウンロードに少し時間がかかります。"
        : null;

  return (
    <div className="flex flex-1 flex-col">
      <MobileHeader title={t.nav.search} />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6">
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="メモ名・フォルダ名・本文から探す"
              aria-label="検索"
              autoFocus
              className="pl-9"
            />
          </div>
          {/* Reading search, turned on for a search: the dictionary downloaded
              for the notes not read yet, kept nowhere (lib/search/yomi.ts). */}
          <label
            className="flex shrink-0 cursor-pointer items-center gap-2 text-sm"
            title="ひらがなで、漢字のメモも探します。オンにすると辞書（11MB）をダウンロードするので、少し時間がかかります。辞書は端末に残さず、1 分使わないと削除します。"
          >
            {yomi.busy ? (
              <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />
            ) : null}
            <span className="whitespace-nowrap">読みでも探す</span>
            <Switch
              checked={yomi.on}
              disabled={yomi.busy}
              onCheckedChange={(next) => (next ? void turnOn() : yomi.turnOff())}
            />
          </label>
        </div>

        <p className="text-muted-foreground mt-2 text-xs">
          {query.trim().length === 0
            ? `${total} 件のメモから探せます`
            : `${hits.length} 件見つかりました`}
        </p>
        {status ? (
          <p className="text-muted-foreground mt-1 flex items-start gap-1.5 text-xs leading-relaxed" role="status">
            <Languages className="mt-0.5 size-3.5 shrink-0 opacity-60" aria-hidden />
            <span>{status}</span>
          </p>
        ) : null}
        {lockedNote ? (
          <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
            <Lock className="size-3 shrink-0 opacity-60" aria-hidden />
            <span>{lockedNote}</span>
            {locked.open ? null : (
              <button
                type="button"
                className="text-foreground underline underline-offset-2"
                onClick={() => void requestVault({ kind: "open", from: "general" }, { gesture: true })}
              >
                金庫を開く
              </button>
            )}
          </p>
        ) : null}

        <ScrollArea className="mt-3 min-h-0 flex-1">
          {query.trim().length > 0 && hits.length === 0 ? (
            <p className="text-muted-foreground py-16 text-center text-sm">
              {t.empty.noResults}
            </p>
          ) : null}

          <ul className="divide-y">
            {hits.map((hit) => (
              <li key={hit.noteId}>
                <button
                  type="button"
                  onClick={() => router.push(`/app?n=${hit.noteId}`)}
                  className="hover:bg-accent/50 flex w-full flex-col gap-1 px-1 py-3 text-left"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {hit.locked ? <Lock className="size-3 opacity-60" aria-hidden /> : null}
                    <NoteName hit={hit} className="min-w-0 truncate" />
                    {hit.folderName ? (
                      <span className="text-muted-foreground shrink-0 text-xs font-normal whitespace-nowrap">
                        / {hit.folderName}
                      </span>
                    ) : null}
                  </span>
                  {hit.matchedIn === "body" ? (
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      <Highlighted snippet={hit.snippet} />
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </div>
    </div>
  );
}
