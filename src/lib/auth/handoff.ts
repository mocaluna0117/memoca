/**
 * Signing the desktop shell in (docs/STORAGE-AND-DESKTOP.md, D0). Google
 * turns away a sign-in inside an app's own window, so the shell opens the
 * browser at /desktop/sign-in with a state of its own making; the browser
 * signs in, and /desktop/handoff gives the shell a one-time token through
 * memoca://auth, state and all; the shell checks the state, and its window
 * exchanges the token at /desktop/complete for the browser's session. Off in
 * production until D1 gives the shell a session of its own (convex/auth.ts).
 */

/** The scheme the desktop shell answers to. */
export const SHELL_SCHEME = "memoca";

/**
 * Whether a state is the shell's: 32 random bytes as base64url, as the shell
 * writes it. It comes back with the token, so the shell can tell a sign-in
 * it started from one it did not.
 */
export const isHandoffState = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

/**
 * Whether a text is a one-time token as the server makes them: 32 of
 * letters, digits, - and _ (better-auth's generateRandomString).
 */
export const isHandoffToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value);

/** A token as it was pasted, with the spaces and line breaks a copy picks up let go. */
export const pastedToken = (text: string) => text.replace(/\s+/g, "");

/** Where the browser signs in for the shell. */
export const desktopSignIn = (state: string) =>
  `/desktop/sign-in?${new URLSearchParams({ state })}`;

/** Where the browser, signed in, hands over to the shell. */
export const desktopHandoff = (state: string) =>
  `/desktop/handoff?${new URLSearchParams({ state })}`;

/**
 * Where the shell's window exchanges its token: in the fragment, which is
 * sent to no server (nor in a Referer), so the token is in no log.
 */
export const desktopComplete = (token: string) =>
  `/desktop/complete#${new URLSearchParams({ token })}`;

/** The token in an address's fragment, when there is one of the right shape. */
export function tokenFromFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return isHandoffToken(token) ? token : null;
}

/** The link that gives the shell its token. */
export const handoffLink = (token: string, state: string) =>
  `${SHELL_SCHEME}://auth?${new URLSearchParams({ token, state })}`;

/** Whether a request comes from the shell's window, by the user agent it gives it. */
export const shellAgent = (userAgent: string | null) => /\bMemocaShell\//.test(userAgent ?? "");
