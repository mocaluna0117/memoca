/**
 * Enter in a note's title goes down to its first line, as in a document:
 * the title field is the note pane's, the editor its own, loaded apart, so
 * the editor showing a note says here what Enter does for it.
 */
const handlers = new Map<string, () => boolean>();

/** Says what Enter in a note's title does, while its editor is shown; returns the undoing. */
export function onTitleEnter(noteId: string, handler: () => boolean): () => void {
  handlers.set(noteId, handler);
  return () => {
    if (handlers.get(noteId) === handler) handlers.delete(noteId);
  };
}

/** Enter in a note's title: true when its editor took it (the caret went down into the note). */
export function enterFromTitle(noteId: string): boolean {
  return handlers.get(noteId)?.() ?? false;
}
