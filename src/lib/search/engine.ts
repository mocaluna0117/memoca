import { normalize, normalizeMapped, terms } from "./normalize";
import { noteName } from "@/lib/note-name";

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
  /**
   * With no title, the first line of its text, which stands in for one
   * (src/lib/note-name.ts) and is searched as one; empty otherwise.
   */
  standIn: string;
  normalizedStandIn: string;
};

export type SearchHit = {
  noteId: string;
  title: string;
  locked: boolean;
  folderName: string;
  updatedAt: number;
  /**
   * The first line of its text, standing in for a title where it has none
   * (src/lib/note-name.ts); empty where it has one, or is locked.
   */
  standIn: string;
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
  /**
   * The first line of its text, as the note keeps it (note.preview): there
   * even when the text itself is not yet on this device. Null when locked.
   */
  preview?: string | null;
};

export function buildIndex(rows: IndexInput[]): Indexed[] {
  return rows.map((row) => ({
    ...row,
    normalizedTitle: normalize(row.title),
    normalizedBody: row.body === null ? "" : normalize(row.body),
    normalizedFolder: normalize(row.folderName),
    normalizedReading: row.reading ? normalize(row.reading) : "",
    ...standInOf(row),
  }));
}

function standInOf(row: IndexInput): { standIn: string; normalizedStandIn: string } {
  // A locked note's text is not to be read here: its title, or nothing.
  const name = noteName(row.title, row.locked ? null : row.preview || row.body);
  const standIn = name.standIn && !name.untitled ? name.text : "";
  return { standIn, normalizedStandIn: normalize(standIn) };
}

const SNIPPET_RADIUS = 48;

function snippetFor(source: string, needles: string[]): { text: string; highlights: [number, number][] } {
  // A match is found in the folded text, which is not as long as the text
  // (ー and ・ dropped, ｶﾞ one が): where it is in the text itself is read
  // from the folding. Taken as the same place, the window was cut short of
  // the word in a text with many of them, and the marks were a step off for
  // each one before the word (「ーの」 marked for 設定 in サーバーの設定).
  const folded = normalizeMapped(source);
  const first = folded.text.indexOf(needles[0]!);
  if (first < 0) return { text: source.slice(0, SNIPPET_RADIUS * 2), highlights: [] };

  const at = folded.from[first]!;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(source.length, at + SNIPPET_RADIUS);
  const lead = start > 0 ? "…" : "";
  const text = lead + source.slice(start, end) + (end < source.length ? "…" : "");

  const highlights: [number, number][] = [];
  const shown = normalizeMapped(source.slice(start, end));
  for (const needle of needles) {
    let found = shown.text.indexOf(needle);
    while (found >= 0 && highlights.length < 12) {
      highlights.push([
        lead.length + shown.from[found]!,
        lead.length + shown.to[found + needle.length - 1]!,
      ]);
      found = shown.text.indexOf(needle, found + needle.length);
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

    // A first line standing in for a missing title counts as one: a quick
    // note found by its first line ranks as it did when that was its title.
    const inTitle =
      everyTerm((r) => r.normalizedTitle) || everyTerm((r) => r.normalizedStandIn);
    const inBody = everyTerm((r) => r.normalizedBody);
    const inFolder = everyTerm((r) => r.normalizedFolder);
    const inReading = everyTerm((r) => r.normalizedReading);
    const anywhere = needles.every(
      (needle) =>
        row.normalizedTitle.includes(needle) ||
        row.normalizedStandIn.includes(needle) ||
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
        ? snippetFor(row.body ?? "", needles)
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
        standIn: row.standIn,
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
