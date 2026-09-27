/**
 * What the desktop shell (docs/STORAGE-AND-DESKTOP.md, 第 3 段) gives the
 * page it shows, as `window.memocaShell`.
 */
export type MemocaShell = {
  /** Puts the window away, to be shown again as it was. */
  hide(): void;
  /** Opens a link in the default browser: the shell's window is the quick note's alone. */
  openExternal(url: string): void;
  /** Starts signing in through the default browser (see D0). */
  beginSignIn?(): void;
  platform: "macos" | "windows";
};

declare global {
  interface Window {
    memocaShell?: MemocaShell;
  }
}

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

/**
 * Opens a page of the app from the quick note's window: in the browser, from
 * the shell; in the window that opened this one, where there is one; else
 * here, in place of the quick note. `here` as for {@link closeQuickWindow}.
 */
export function openInApp(path: string, here: Window = window): void {
  if (here.memocaShell) {
    here.memocaShell.openExternal(new URL(path, here.location.origin).href);
    return;
  }
  const opener = here.opener as Window | null;
  if (opener && !opener.closed) {
    try {
      opener.location.assign(path);
      opener.focus();
      return;
    } catch {
      // Opened from another site after all: not ours to steer.
    }
  }
  here.location.assign(path);
}
