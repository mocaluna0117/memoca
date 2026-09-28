/**
 * What the desktop shell (docs/STORAGE-AND-DESKTOP.md, 第 3 段) gives the
 * page it shows, as `window.memocaShell`.
 */
export type MemocaShell = {
  /** Puts the window away, to be shown again as it was. */
  hide(): void;
  /** Opens a link in the default browser: the shell's window is the quick note's alone. */
  openExternal(url: string): void;
  /**
   * Starts signing in through the default browser (src/lib/auth/handoff.ts),
   * with the few letters the browser will show for it.
   */
  beginSignIn?(): Promise<string>;
  /**
   * Signs in with a code pasted from the browser: the shell sends the window
   * to take it, with its verifier, for the sign-in it started ("ok"), or
   * turns it away if it started none, or that one was too long ago.
   */
  completeSignIn?(code: string): Promise<"ok" | "not-started">;
  /** What /desktop/complete takes, handed over once, just after the shell sends the window there. */
  takeSignIn?(): Promise<{ code: string; verifier: string } | null>;
  platform: "macos" | "windows";
};

declare global {
  interface Window {
    memocaShell?: MemocaShell;
  }
}

/**
 * What the shell tells the page as it puts the window away, keeping it
 * loaded (desktop/src-tauri/src/window.rs).
 */
export const SHELL_HIDDEN = "memoca-shell-hidden";

/** The user agent the shell gives its window, ahead of the page's script. */
const SHELL_AGENT = /\bMemocaShell\//;

/** Whether this page is shown by the desktop shell. */
export function inShell(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.memocaShell !== undefined || SHELL_AGENT.test(navigator.userAgent))
  );
}

/**
 * Puts the quick note's window away: the shell hides it; a window a page of
 * the app opened for it is closed. A browser keeps any other window open.
 * `here` is this window: another only in tests.
 */
export function closeQuickWindow(here: Window = window): void {
  if (here.memocaShell) here.memocaShell.hide();
  else here.close();
}

/** The message a quick note's window sends the app's window that opened it. */
export const OPEN_NOTE = "memoca:open-note";
export type OpenNoteMessage = { type: typeof OPEN_NOTE; noteId: string };

/** The app's window's answer: it has moved to the note. */
export const OPENED_NOTE = "memoca:opened-note";
export type OpenedNoteMessage = { type: typeof OPENED_NOTE; noteId: string };

/**
 * How long the app's window has to answer before it is loaded with the note
 * instead: one of an earlier version of the app, open since before the quick
 * note could ask, does not listen.
 */
export const ANSWER_MS = 800;

/**
 * Opens a note just saved, from the quick note's window: in the browser,
 * from the shell. From a window the app opened, in the app there, told to
 * move to it rather than loaded again, which would close its vault (loaded
 * after all if it does not answer); or, if that window has left the app,
 * loaded there. With no window of the app at hand, in a new one, so this
 * one stays the quick note. `here` as for {@link closeQuickWindow}.
 */
export function openNoteInApp(noteId: string, here: Window = window): void {
  const path = `/app?${new URLSearchParams({ n: noteId })}`;
  if (here.memocaShell) {
    here.memocaShell.openExternal(new URL(path, here.location.origin).href);
    return;
  }
  const opener = here.opener as Window | null;
  if (opener && !opener.closed) {
    try {
      if (opener.location.pathname.startsWith("/app")) {
        const answered = (event: MessageEvent) => {
          const data = event.data as Partial<OpenedNoteMessage> | null;
          if (event.origin !== here.location.origin || data?.type !== OPENED_NOTE) return;
          if (data.noteId !== noteId) return;
          clearTimeout(unanswered);
          here.removeEventListener("message", answered);
        };
        const unanswered = setTimeout(() => {
          here.removeEventListener("message", answered);
          try {
            opener.location.assign(path);
          } catch {
            // Gone, or elsewhere since: nothing to load it in.
          }
        }, ANSWER_MS);
        here.addEventListener("message", answered);
        opener.postMessage(
          { type: OPEN_NOTE, noteId } satisfies OpenNoteMessage,
          here.location.origin,
        );
      } else {
        opener.location.assign(path);
      }
      opener.focus();
      return;
    } catch {
      // Another site's window after all: not ours to steer.
    }
  }
  if (!here.open(path, "_blank")) here.location.assign(path);
}
