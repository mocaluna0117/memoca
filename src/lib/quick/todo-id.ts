/**
 * The quick note's Todo, by its id: one list per account, kept as a note of
 * its own, synced as any note is (see lib/quick/todo), which Memoca's own
 * lists, sidebar, search and links to notes leave out. Its id is the same
 * on every device, so two that make it make one.
 * Apart from lib/quick/todo, which writes, so that what only reads imports nothing.
 */
export const TODO_NOTE_ID = "quick-todo";

/** The quick note's tab the Todo is shown in: one, and of its own kind. */
export const TODO_TAB_ID = "todo";

/**
 * Whether a note is the quick note's Todo. One made again after the first
 * was deleted for good has an id after it (see ensureTodoNote).
 */
export function isQuickTodo(noteId: string): boolean {
  return noteId === TODO_NOTE_ID || noteId.startsWith(`${TODO_NOTE_ID}-`);
}

/**
 * What a quick note's tab's note is named by: each tab a note of its own,
 * synced as any note is, so that every device of the account has the same
 * tabs (lib/quick/tabs), left out of Memoca's own lists as the Todo is.
 * Saved, a tab's quick note is copied into a note of its own (kind "quick").
 */
export const QUICK_TAB_PREFIX = "quick-tab-";

/** Whether a note is a quick note's tab's. */
export const isQuickTab = (noteId: string) => noteId.startsWith(QUICK_TAB_PREFIX);

/** Whether a note is the quick note's own (its Todo, a tab's), not one of Memoca's lists. */
export const isHiddenNote = (noteId: string) => isQuickTodo(noteId) || isQuickTab(noteId);
