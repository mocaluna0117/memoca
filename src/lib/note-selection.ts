/**
 * Notes chosen in the list, to be moved together: by ⌘/Ctrl or Shift and a
 * click on a computer, or a tap each once the list is set to choose (as on a
 * phone). By id, in the list's order where an order matters.
 */

/** The notes from one to another as the list has them, both included; the one alone if the other is not there. */
export function rangeOf(order: readonly string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (end < 0) return [];
  if (start < 0) return [to];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** The chosen ones, with one taken out if it was there, put in if it was not. */
export function toggled(chosen: ReadonlySet<string>, noteId: string): Set<string> {
  const next = new Set(chosen);
  if (next.has(noteId)) next.delete(noteId);
  else next.add(noteId);
  return next;
}

/**
 * What dragging a note takes along: every chosen note, in the list's order,
 * if it is one of them; otherwise it alone.
 */
export function takenWith(
  order: readonly string[],
  chosen: ReadonlySet<string>,
  noteId: string,
): string[] {
  if (!chosen.has(noteId)) return [noteId];
  return order.filter((id) => chosen.has(id));
}

/**
 * A Shift and a click, as in Finder and Explorer: what was chosen when the
 * anchor was set, and the notes from the anchor to this one. A second one
 * from the same anchor takes the place of the first.
 */
export function extendTo(
  base: ReadonlySet<string>,
  order: readonly string[],
  anchor: string,
  to: string,
): Set<string> {
  return new Set([...base, ...rangeOf(order, anchor, to)]);
}
