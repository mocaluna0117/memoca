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
  // Judged as the address reads once parsed, not as it was written: dot
  // segments make "/.//evil.example" into "//evil.example", another site.
  if (url.origin !== PROBE || url.pathname.startsWith("//")) return null;
  if (url.pathname.replace(/\/+$/, "") === "/sign-in") return null;
  return url.pathname + url.search;
}

/**
 * The characters better-auth takes as they are in the path and in the query
 * of a callback URL on this site (its trusted-origins check); it turns away
 * any other, a `*` in a shared text say, and the sign-in with it.
 */
const CALLBACK_PATH = /^\/[\w\-.+/@]*$/;
const CALLBACK_QUERY_CHARACTER = /[\w\-.+/=&%@]/;

/**
 * A path from {@link safeNext}, written as better-auth accepts a callback:
 * any other character of the query percent-encoded (which reads back the
 * same). A path it would not accept however written leads home instead.
 */
export function forCallback(path: string): string {
  const at = path.indexOf("?");
  const pathname = at === -1 ? path : path.slice(0, at);
  if (!CALLBACK_PATH.test(pathname)) return HOME;
  if (at === -1) return pathname;
  let query = "";
  for (const character of path.slice(at + 1)) {
    query += CALLBACK_QUERY_CHARACTER.test(character)
      ? character
      : Array.from(
          new TextEncoder().encode(character),
          (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
        ).join("");
  }
  return `${pathname}?${query}`;
}

/** The sign-in page, told to come back to `path` afterwards. */
export const signInReturningTo = (path: string) =>
  `/sign-in?${new URLSearchParams({ next: path })}`;
