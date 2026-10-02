/**
 * Where each note was last read, so that it opens there again rather than
 * at its top: by the line at the top of the screen (its block's id) and how
 * far down into it the screen began, not by pixels, which an image above it
 * loading, or a line changed on another device, would throw out. Kept on this
 * device, for the notes opened last.
 */
export type Place = {
  /** The block whose line was at the top. */
  block: string;
  /** How far the top of the screen was below the top of that line, in pixels. */
  offset: number;
};

/** A line of the note on the screen: its block's id, and where it is. */
export type Line = { id: string; top: number; bottom: number };

/**
 * The place for lines as they are on the screen, below `viewTop` (the
 * bottom of what is drawn over the note there): the first line not wholly
 * above it. None if there is no line.
 */
export function placeAt(lines: Iterable<Line>, viewTop: number): Place | null {
  for (const line of lines) {
    if (line.bottom > viewTop) return { block: line.id, offset: Math.round(viewTop - line.top) };
  }
  return null;
}

/** How far to scroll for a line now at `lineTop` to be back where `place` had it. */
export const scrollToPlace = (place: Place, lineTop: number, viewTop: number) =>
  lineTop + place.offset - viewTop;

const KEY = "memoca:note-places";
/** As many notes as are kept, the ones read longest ago going first. */
export const KEPT = 200;

/**
 * Kept here instead, for the session, once storage is not to be had (a
 * private window, or full).
 */
let session: Map<string, Place> | null = null;

/**
 * The places kept, as they are now: read each time, as another tab of the
 * app may have kept some since, which writing back an older copy would lose.
 */
function kept(): Map<string, Place> {
  if (session) return session;
  const places = new Map<string, Place>();
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1]?.block === "string" &&
          typeof entry[1]?.offset === "number"
        ) {
          places.set(entry[0], { block: entry[1].block, offset: entry[1].offset });
        }
      }
    }
  } catch {
    // Nothing kept, or not readable: every note opens at its top.
  }
  return places;
}

/** Where a note was last read, if it is kept. */
export function placeOf(noteId: string): Place | null {
  return kept().get(noteId) ?? null;
}

/** Keeps where a note is being read, as the one read last. */
export function rememberPlace(noteId: string, place: Place) {
  const all = kept();
  all.delete(noteId);
  all.set(noteId, place);
  while (all.size > KEPT) all.delete(all.keys().next().value!);
  try {
    localStorage.setItem(KEY, JSON.stringify([...all]));
  } catch {
    session = all;
  }
}

/**
 * Forgets every place, as the device forgets an account (signing out, say):
 * the notes' ids would say when they were made.
 */
export function forgetPlaces() {
  session = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept to forget.
  }
}
