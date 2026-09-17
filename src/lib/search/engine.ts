import { normalize, terms } from "./normalize";

export type Indexed = {
  noteId: string;
  folderId: string | null;
  title: string;
  /** Null when the note is locked and the vault is closed. */
  body: string | null;
  folderName: string;
  locked: boolean;
  updatedAt: number;
  normalizedTitle: string;
  normalizedBody: string;
  normalizedFolder: string;
};

export type SearchHit = {
  noteId: string;
  title: string;
  locked: boolean;
  folderName: string;
  updatedAt: number;
  /** Where the match was found, best first. */
  matchedIn: "title" | "body" | "folder";
  snippet: { text: string; highlights: [number, number][] };
};

export type IndexInput = {
  noteId: string;
  folderId: string | null;
  title: string;
  body: string | null;
  folderName: string;
  locked: boolean;
  updatedAt: number;
};

export function buildIndex(rows: IndexInput[]): Indexed[] {
  return rows.map((row) => ({
    ...row,
    normalizedTitle: normalize(row.title),
    normalizedBody: row.body === null ? "" : normalize(row.body),
    normalizedFolder: normalize(row.folderName),
  }));
}

const SNIPPET_RADIUS = 48;

function snippetFor(
  source: string,
  normalized: string,
  needles: string[],
): { text: string; highlights: [number, number][] } {
  const first = normalized.indexOf(needles[0]!);
  if (first < 0) return { text: source.slice(0, SNIPPET_RADIUS * 2), highlights: [] };

  // Normalisation is a per-character mapping that can drop characters, so
  // offsets are approximate; clamping keeps the snippet sane either way.
  const start = Math.max(0, first - SNIPPET_RADIUS);
  const end = Math.min(source.length, first + SNIPPET_RADIUS);
  const text = (start > 0 ? "…" : "") + source.slice(start, end) + (end < source.length ? "…" : "");

  const highlights: [number, number][] = [];
  const lowered = normalize(text);
  for (const needle of needles) {
    let at = lowered.indexOf(needle);
    while (at >= 0 && highlights.length < 12) {
      highlights.push([at, at + needle.length]);
      at = lowered.indexOf(needle, at + needle.length);
    }
  }
  return { text, highlights };
}

/**
 * Substring search over titles, bodies and folder names.
 *
 * Convex's own text index tokenises on whitespace, which does nothing useful
 * for Japanese, and the bodies of locked notes are ciphertext the server could
 * not index anyway. Searching on the device solves both at once, and at a
 * personal note-taking scale a scan over a few thousand pre-normalised strings
 * takes single-digit milliseconds.
 */
export function search(index: Indexed[], query: string, limit = 50): SearchHit[] {
  const needles = terms(query);
  if (needles.length === 0) return [];

  const scored: { score: number; hit: SearchHit }[] = [];
  for (const row of index) {
    const inTitle = needles.every((n) => row.normalizedTitle.includes(n));
    const inBody = needles.every((n) => row.normalizedBody.includes(n));
    const inFolder = needles.every((n) => row.normalizedFolder.includes(n));
    if (!inTitle && !inBody && !inFolder) continue;

    const matchedIn = inTitle ? "title" : inBody ? "body" : "folder";
    const snippet =
      matchedIn === "body"
        ? snippetFor(row.body ?? "", row.normalizedBody, needles)
        : { text: row.title, highlights: [] as [number, number][] };

    scored.push({
      score: matchedIn === "title" ? 2 : matchedIn === "body" ? 1 : 0,
      hit: {
        noteId: row.noteId,
        title: row.title,
        locked: row.locked,
        folderName: row.folderName,
        updatedAt: row.updatedAt,
        matchedIn,
        snippet,
      },
    });
  }

  return scored
    .sort((a, b) =>
      b.score === a.score ? b.hit.updatedAt - a.hit.updatedAt : b.score - a.score,
    )
    .slice(0, limit)
    .map((entry) => entry.hit);
}
