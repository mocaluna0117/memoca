/**
 * Signing the desktop shell in (docs/STORAGE-AND-DESKTOP.md, D0 and D1).
 * Google turns away a sign-in inside an app's own window, so it is done in
 * the browser:
 *
 * 1. The shell makes a state, and a secret of its own (the verifier), and
 *    opens the browser at /desktop/sign-in with the state and the verifier's
 *    hash (the challenge). The verifier never leaves the shell but for
 *    Memoca's own page in its window.
 * 2. The browser, signed in within the last few minutes, has the server
 *    make a code for that challenge (convex/lib/desktopSignIn.ts) at
 *    /desktop/handoff, and offers memoca://auth with the code and the state.
 * 3. The shell checks the state is the one it is waiting for, sends its
 *    window to /desktop/complete, and hands that page the code and the
 *    verifier, which it takes for a session of the window's own. A code
 *    pasted into the window goes the same way.
 *
 * Both pages show the same few letters, made from the challenge, so the
 * person can see the browser is signing in the shell in front of them.
 * Off in production until the deployment turns it on (convex/auth.ts).
 */

/** The scheme the desktop shell answers to. */
export const SHELL_SCHEME = "memoca";

/** 32 bytes as base64url, as the shell writes its state, its verifier, and the challenge. */
const BYTES_32 = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether a state is the shell's: 32 random bytes as base64url. It comes
 * back with the code, so the shell can tell a sign-in it started from one it
 * did not.
 */
export const isHandoffState = (value: unknown): value is string =>
  typeof value === "string" && BYTES_32.test(value);

/** Whether a challenge is the shell's: the SHA-256 of its verifier, as base64url. */
export const isHandoffChallenge = isHandoffState;

/** Whether a verifier is the shell's: 32 random bytes as base64url. */
export const isHandoffVerifier = isHandoffState;

/** Whether a text is a code as the server makes them: 32 letters and digits. */
export const isHandoffCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9]{32}$/.test(value);

/** A code as it was pasted, with the spaces and line breaks a copy picks up let go. */
export const pastedCode = (text: string) => text.replace(/\s+/g, "");

/** What the shell sends the browser with: its state, and its challenge. */
export type HandoffRequest = { state: string; challenge: string };

/** Where the browser signs in for the shell. */
export const desktopSignIn = ({ state, challenge }: HandoffRequest) =>
  `/desktop/sign-in?${new URLSearchParams({ state, challenge })}`;

/** Where the browser, signed in, hands over to the shell. */
export const desktopHandoff = ({ state, challenge }: HandoffRequest) =>
  `/desktop/handoff?${new URLSearchParams({ state, challenge })}`;

/**
 * How recently the browser must have signed in to make a code: the server
 * says so too (convex/lib/desktopSignIn.ts, FRESH_MS), with a little room
 * left here for the time the button takes.
 */
export const FRESH_MS = 10 * 60 * 1000 - 30 * 1000;

/**
 * The few letters both pages show for a sign-in: the first eight hex digits
 * of the challenge's SHA-256, as 1A2B-3C4D (sign_in.rs makes them the same way).
 */
export async function handoffCheck(challenge: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(challenge)),
  );
  const hex = Array.from(hash.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** The link that gives the shell its code. */
export const handoffLink = (code: string, state: string) =>
  `${SHELL_SCHEME}://auth?${new URLSearchParams({ code, state })}`;

/** Whether a request comes from the shell's window, by the user agent it gives it. */
export const shellAgent = (userAgent: string | null) => /\bMemocaShell\//.test(userAgent ?? "");
