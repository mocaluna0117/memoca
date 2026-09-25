"use client";

import { Languages, Loader2, Lock, Search as SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MobileHeader } from "@/components/shell/app-shell";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useSearch } from "@/lib/hooks/use-search";
import { useYomi } from "@/lib/hooks/use-yomi";
import { lockedSearchNote } from "@/lib/search/rows";
import { isKanaQuery } from "@/lib/search/yomi";
import { requestVault } from "@/lib/store/vault-gate";
import type { SearchHit } from "@/lib/search/engine";
import { t } from "@/lib/i18n/ja";

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

  // Offer reading search exactly where it would have helped: a kana-only query
  // that found nothing, which is what typing a kanji word's reading looks like.
  const suggestYomi =
    yomi.enabled === false && hits.length === 0 && isKanaQuery(query);

  return (
    <div className="flex flex-1 flex-col">
      <MobileHeader title={t.nav.search} />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6">
        <div className="relative">
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

        <p className="text-muted-foreground mt-2 text-xs">
          {query.trim().length === 0
            ? `${total} 件のメモから探せます`
            : `${hits.length} 件見つかりました`}
        </p>
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

        {suggestYomi ? (
          <div className="bg-card mt-3 flex items-start gap-3 rounded-lg border p-3">
            <Languages className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm font-medium">読み方でも探せます</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                有効にすると「やっきょく」で「薬局」のような漢字のメモが見つかります。
                日本語の辞書 17MB を一度だけダウンロードします。
              </p>
              <Button size="sm" onClick={() => void yomi.enable()} disabled={yomi.busy}>
                {yomi.busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                {yomi.busy
                  ? yomi.progress && yomi.progress.total > 0
                    ? `読み込み中 ${yomi.progress.done} / ${yomi.progress.total}`
                    : "ダウンロード中…"
                  : "有効にする"}
              </Button>
            </div>
          </div>
        ) : null}

        <ScrollArea className="mt-3 min-h-0 flex-1">
          {query.trim().length > 0 && hits.length === 0 && !suggestYomi ? (
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
                    {hit.title || "無題のメモ"}
                    {hit.folderName ? (
                      <span className="text-muted-foreground text-xs font-normal">
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
