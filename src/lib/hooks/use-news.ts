"use client";

import { useSyncExternalStore } from "react";
import { useSync } from "@/components/providers/sync-provider";
import { NEWS } from "@/lib/news";

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
export function unread(joinedAt: number | null | undefined): number {
  const seen = seenId();
  const at = seen === null ? -1 : NEWS.findIndex((item) => item.id === seen);
  if (at >= 0) return at;
  if (joinedAt == null) return 0;
  const joined = dayOf(joinedAt);
  return NEWS.filter((item) => item.date > joined).length;
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
  return useSyncExternalStore(
    subscribe,
    () => unread(joinedAt),
    () => 0,
  );
}

/** Marks every お知らせ there is as seen on this device. */
export function markNewsSeen(): void {
  const newest = NEWS[0];
  if (!newest) return;
  try {
    localStorage.setItem(KEY, newest.id);
  } catch {
    // Refused: it stays as it was.
  }
  for (const listener of listeners) listener();
}
