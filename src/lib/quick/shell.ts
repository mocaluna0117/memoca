/**
 * What the desktop shell (docs/STORAGE-AND-DESKTOP.md, 第 3 段) gives the
 * page it shows, as `window.memocaShell`.
 */
export type MemocaShell = {
  /** Puts the window away, to be shown again as it was. */
  hide(): void;
  /** Opens one of Memoca's pages in the default browser. */
  openExternal(url: string): void;
  /**
   * Opens one of Memoca's pages in the shell's window for the whole app
   * (desktop/src-tauri/src/app_window.rs): a note there is moved to, as
   * {@link OpenNoteMessage} has it. Not in shells before 0.3.0.
   */
  openApp?(url: string): void;
  /** Brings out the shell's quick note, in place of a window of the page's. Not before 0.3.0. */
  showQuick?(): void;
  /**
   * Puts the quick note away and brings out the shell's window for the whole
   * app, opened on the notes or as it was left. Not before 0.4.1.
   */
  showApp?(): void;
  /**
   * Puts images on the clipboard as files, as copied in Finder or Explorer,
   * for other apps to paste all of (src/components/editor/plain-copy.ts):
   * each named, its bytes base64. Not before 0.4.2.
   */
  copyImages?(images: { name: string; data: string }[]): Promise<void>;
  /**
   * The computer's own check (Touch ID, Windows Hello) for the vault
   * (src/lib/vault/device-unlock.ts). Not before 0.4.0.
   */
  deviceUnlock?: {
    /** Which check the computer has, if any. */
    kind(): Promise<DeviceUnlockKind | null>;
    /** The computer's secret, base64, once the person has proved themselves; made if `create`. */
    secret(create: boolean): Promise<string>;
  };
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
  /**
   * The Todo's reminders, shown by the computer's own notifications
   * (desktop/src-tauri/src/reminders.rs) at their times: whether this
   * computer shows them, and the account's, as the server keeps them,
   * handed over as they change (from the quick note's window alone). Not
   * before 0.4.10.
   */
  reminders?: {
    state(): Promise<ShellReminderState>;
    /** The system asked (a Mac shows its question): where it stands after. */
    turnOn(): Promise<ShellReminderState>;
    turnOff(): Promise<void>;
    set(reminders: readonly ShellReminder[]): void;
  };
  /**
   * The app's hotkeys (desktop/src-tauri/src/shortcut.rs), changed from the
   * settings page and in use at once. Not before 0.4.11.
   */
  hotkeys?: {
    get(): Promise<ShellHotkeys>;
    /**
     * One changed: what they are after; or, turned away, an error that is
     * one of {@link HotkeyRefusal}, the hotkeys left as they were.
     */
    set(which: "quick" | "app", keys: string): Promise<ShellHotkeys>;
    /** Keys being recorded: the hotkeys let go of meanwhile (for a minute at most), so the page sees them. */
    recording(on: boolean): Promise<void>;
  };
  /**
   * Signing out of the app, from its menu, once the page is sure of it:
   * the app lets go of Memoca's own window (and its open vault) and of the
   * account's reminders. Not before 0.4.13, where the menu did so at once.
   */
  signOut?(): Promise<void>;
  platform: "macos" | "windows";
};

/** The app's hotkeys, as settings.json writes them ("CmdOrCtrl+Shift+M"), and what each is unless changed. */
export type ShellHotkeys = {
  quick: string;
  app: string;
  quickDefault: string;
  appDefault: string;
  /** Whether each took as the app last registered it (another app's keys do not). Not before 0.4.13. */
  quickWorks?: boolean;
  appWorks?: boolean;
};

/**
 * Why the app turned keys away: not a hotkey; one that would take what is
 * typed (no ⌘, ⌃ or ⌥ held, but for F1 to F24); the other one's keys; or
 * another app's.
 */
export type HotkeyRefusal = "invalid" | "needsModifier" | "same" | "taken";

export type DeviceUnlockKind = "touchId" | "windowsHello";

/**
 * Where the computer stands on the Todo's reminders: "blocked" when chosen
 * but its settings keep them from showing; "unsupported" when the app can
 * show none (a Mac's not in an Applications folder).
 */
export type ShellReminderState = "on" | "off" | "blocked" | "unsupported";

/** A reminder as the shell is given it: as convex/reminders.ts `list` has it. */
export type ShellReminder = { key: string; at: number; title: string; body: string };

/** What the shell tells the page as one of the Todo's reminders is clicked: the Todo shown. */
export const SHELL_OPEN_TODO = "memoca-shell-open-todo";

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
 * Opens a note just saved, from the quick note's window: in the shell's
 * window for the whole app, from the shell (in the browser, from a shell
 * that has none). From a window the app opened, in the app there, told to
 * move to it rather than loaded again, which would close its vault (loaded
 * after all if it does not answer); or, if that window has left the app,
 * loaded there. With no window of the app at hand, in a new one, so this
 * one stays the quick note. `here` as for {@link closeQuickWindow}.
 */
export function openNoteInApp(noteId: string, here: Window = window): void {
  const path = `/app?${new URLSearchParams({ n: noteId })}`;
  const shell = here.memocaShell;
  if (shell) {
    const href = new URL(path, here.location.origin).href;
    if (shell.openApp) shell.openApp(href);
    else shell.openExternal(href);
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
