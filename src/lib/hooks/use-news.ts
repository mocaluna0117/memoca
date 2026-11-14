"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useSync } from "@/components/providers/sync-provider";

/** What the unread count needs of each お知らせ: when, and which. */
type Dated = { id: string; date: string };

/**
 * The お知らせ, loaded once the shell is up: not in the JavaScript every page
 * starts with (all of them, 120 KB and growing with each change), for a dot
 * on one button. Null until then, and none unread.
 */
let loaded: readonly Dated[] | null = null;
let loading: Promise<void> | null = null;

function loadNews(): Promise<void> {
  loading ??= import("@/lib/news").then(({ NEWS }) => {
    loaded = NEWS.map(({ id, date }) => ({ id, date }));
    for (const listener of listeners) listener();
  });
  return loading;
}

/** Where this device keeps the newest お知らせ it has seen, by its id. */
const KEY = "memoca:news-seen";

const listeners = new Set<() => void>();

function seenId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Storage refused (a private window, say): nothing seen.
    return null;
  }
}

/** A time's day here, as the お知らせ are dated: YYYY-MM-DD. */
const dayOf = (at: number) => {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * How many of the お知らせ came after the newest this device has seen.
 * With none seen here, those dated after the day the account was made
 * (`joinedAt`): what came before is not news to someone new. Not knowing
 * when that was yet, none.
 */
export function unread(joinedAt: number | null | undefined, news: readonly Dated[] | null = loaded): number {
  if (!news) return 0;
  const seen = seenId();
  const at = seen === null ? -1 : news.findIndex((item) => item.id === seen);
  if (at >= 0) return at;
  if (joinedAt == null) return 0;
  const joined = dayOf(joinedAt);
  return news.filter((item) => item.date > joined).length;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Seen in another tab.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * How many お知らせ this device has not seen yet (see {@link unread}). None on
 * the server's page and the first render, which cannot know.
 */
export function useUnreadNews(): number {
  const joinedAt = useSync().me?.createdAt;
  useEffect(() => {
    void loadNews().catch(() => {
      // Offline before the お知らせ were ever loaded: tried again next time.
      loading = null;
    });
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => unread(joinedAt),
    () => 0,
  );
}

/** Marks every お知らせ there is as seen on this device. */
export function markNewsSeen(newest: Dated | undefined): void {
  if (!newest) return;
  try {
    localStorage.setItem(KEY, newest.id);
  } catch {
    // Refused: it stays as it was.
  }
  for (const listener of listeners) listener();
}
