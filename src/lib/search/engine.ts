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
  /** Reading of title and body; empty when the dictionary is not in use. */
  normalizedReading: string;
};

export type SearchHit = {
  noteId: string;
  title: string;
  locked: boolean;
  folderName: string;
  updatedAt: number;
  /** Where the match was found, best first. */
  matchedIn: "title" | "body" | "folder" | "reading";
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
  /** Katakana reading of title and body, when one has been computed. */
  reading?: string | null;
};

export function buildIndex(rows: IndexInput[]): Indexed[] {
  return rows.map((row) => ({
    ...row,
    normalizedTitle: normalize(row.title),
    normalizedBody: row.body === null ? "" : normalize(row.body),
    normalizedFolder: normalize(row.folderName),
    normalizedReading: row.reading ? normalize(row.reading) : "",
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
    // Each term may land in any field, so "薬局 よてい" can match a kanji word
    // literally and a second one by its reading.
    const everyTerm = (pick: (row: Indexed) => string) =>
      needles.every((needle) => pick(row).includes(needle));

    const inTitle = everyTerm((r) => r.normalizedTitle);
    const inBody = everyTerm((r) => r.normalizedBody);
    const inFolder = everyTerm((r) => r.normalizedFolder);
    const inReading = everyTerm((r) => r.normalizedReading);
    const anywhere = needles.every(
      (needle) =>
        row.normalizedTitle.includes(needle) ||
        row.normalizedBody.includes(needle) ||
        row.normalizedFolder.includes(needle) ||
        row.normalizedReading.includes(needle),
    );
    if (!anywhere) continue;

    // A literal match is a stronger signal than one found through a reading,
    // which is why reading sits below body here.
    const matchedIn = inTitle
      ? "title"
      : inBody
        ? "body"
        : inReading
          ? "reading"
          : inFolder
            ? "folder"
            : "body";
    const score = inTitle ? 3 : inBody ? 2 : inReading ? 1 : 0;

    const snippet =
      matchedIn === "body"
        ? snippetFor(row.body ?? "", row.normalizedBody, needles)
        : matchedIn === "reading"
          ? { text: (row.body ?? "").slice(0, SNIPPET_RADIUS * 2), highlights: [] }
          : { text: row.title, highlights: [] as [number, number][] };

    scored.push({
      score,
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
