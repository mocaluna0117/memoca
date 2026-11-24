import { normalize } from "./normalize";

/**
 * The searches made last on this device, newest first, for the search page
 * to offer again while its field is empty. Kept here only, never sent: what
 * someone looks for is theirs, and a word of a locked note among it would
 * say what is in it. Forgotten with the rest of the account's data on this
 * device (resetLocalData), as signing out does.
 *
 * A search is kept once it was used: a note opened from its results, or
 * Enter pressed in the field. Not what is typed on the way there.
 */
const KEY = "memoca:search-history";
/** As many as are kept, the oldest going first. */
export const HISTORY_SIZE = 10;
/** Longer than this, a search is not kept: a paste of a passage, not a search to make again. */
const LONGEST = 100;

/** Kept here instead, for the session, once storage is not to be had (a private window, or full). */
let session: string[] | null = null;

/** What is shown, read once until it changes (see useSyncExternalStore), and who is shown it. */
let shown: readonly string[] | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  shown = null;
  for (const listener of listeners) listener();
};

/** For useSyncExternalStore: told whenever the searches kept change. */
export function subscribeSearchHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For useSyncExternalStore: the searches kept, the same array while they stay the same. */
export function searchHistorySnapshot(): readonly string[] {
  return (shown ??= searchHistory());
}

/** A search as it is told apart from another: the same however it is written (カナ or かな, spaces). */
const sameAs = (query: string) => normalize(query).replace(/\s+/g, " ").trim();

/** The searches kept, newest first. */
export function searchHistory(): string[] {
  if (session) return [...session];
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === "string").slice(0, HISTORY_SIZE)
      : [];
  } catch {
    // Nothing kept, or not readable.
    return [];
  }
}

function keep(entries: string[]): string[] {
  const kept = entries.slice(0, HISTORY_SIZE);
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
    session = null;
  } catch {
    session = kept;
  }
  changed();
  return [...kept];
}

/**
 * Keeps a search, as the one made last: the same search made before (written
 * otherwise, maybe) goes, this one taking its place at the top as it was
 * written now. Nothing for a search of nothing, or a passage pasted in.
 */
export function rememberSearch(query: string): string[] {
  const written = query.replace(/\s+/g, " ").trim();
  if (!written || written.length > LONGEST) return searchHistory();
  const key = sameAs(written);
  return keep([written, ...searchHistory().filter((entry) => sameAs(entry) !== key)]);
}

/** Forgets one search kept. */
export function forgetSearch(query: string): string[] {
  const key = sameAs(query);
  return keep(searchHistory().filter((entry) => sameAs(entry) !== key));
}

/** Forgets every search kept: from the search page, or as the device forgets an account. */
export function forgetSearchHistory(): void {
  session = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept to forget.
  }
  changed();
}
