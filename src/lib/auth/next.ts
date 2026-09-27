/** Where sign-in leads when it was not started from anywhere in particular. */
export const HOME = "/app";

/**
 * The request header src/proxy.ts puts the asked-for address in (path and
 * query), for the workspace layout, which has no other way of knowing it.
 */
export const ASKED_FOR = "x-memoca-asked-for";

/** An address that is not really a base of ours, to read a path against. */
const PROBE = "https://probe.invalid";

/**
 * The page to come back to after signing in, as given in `?next=`: only a
 * path on this site, and not the sign-in page itself. Anything else, a link
 * to another site above all, is not followed.
 */
export function safeNext(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\u0000-\u001f]/.test(value)) return null;
  const url = new URL(value, PROBE);
  if (url.origin !== PROBE || url.pathname === "/sign-in") return null;
  return url.pathname + url.search;
}

/** The sign-in page, told to come back to `path` afterwards. */
export const signInReturningTo = (path: string) =>
  `/sign-in?${new URLSearchParams({ next: path })}`;
