"use client";

import { useEffect, useState } from "react";
import { useSync } from "@/components/providers/sync-provider";
import { MobileHeader } from "@/components/shell/app-shell";
import { markNewsSeen, unread } from "@/lib/hooks/use-news";
import { t } from "@/lib/i18n/ja";
import { NEWS, type NewsItem } from "@/lib/news";

/** A day as it reads: 2026年10月1日. */
function dayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

/** The お知らせ, a day each, newest first. */
function byDay(items: readonly NewsItem[]): [string, NewsItem[]][] {
  const days = new Map<string, NewsItem[]>();
  for (const item of items) days.set(item.date, [...(days.get(item.date) ?? []), item]);
  return [...days.entries()];
}

export default function NewsPage() {
  // Those not seen when the page was opened stay marked new while it is open,
  // though they are seen from then on.
  const joinedAt = useSync().me?.createdAt;
  const [fresh] = useState<ReadonlySet<string>>(
    () => new Set(NEWS.slice(0, unread(joinedAt)).map((item) => item.id)),
  );
  useEffect(() => markNewsSeen(), []);

  return (
    <div className="flex flex-1 flex-col">
      <MobileHeader title={t.nav.news} />
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-4 sm:px-6 sm:py-6">
        <h1 className="text-lg font-semibold tracking-tight">{t.nav.news}</h1>
        <p className="text-sm text-muted-foreground">Memoca の最近のアップデートです。</p>
        <div className="mt-6 flex flex-col gap-8">
          {byDay(NEWS).map(([date, items]) => (
            <section key={date}>
              <h2 className="mb-3 text-xs font-medium text-muted-foreground">{dayOf(date)}</h2>
              <ul className="flex flex-col gap-3">
                {items.map((item) => (
                  <li key={item.id} className="rounded-lg border bg-card px-4 py-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      {item.title}
                      {fresh.has(item.id) ? (
                        <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-primary-foreground">
                          新着
                        </span>
                      ) : null}
                    </h3>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {item.details.map((detail) => (
                        <li key={detail}>{detail}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
