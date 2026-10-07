import { createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/** A match: where it starts and ends in the note. */
export type Match = { from: number; to: number };

/** What is being looked for, and which match is the one on. */
type FindState = { query: string; current: number; matches: Match[]; decorations: DecorationSet };

const key = new PluginKey<FindState>("memocaFind");

/**
 * A character as it is compared: one way of writing it, as search does
 * elsewhere in Memoca. Full-width and half-width alike (Ａ and A, ｱ and ア),
 * capitals and small letters alike, katakana as hiragana. One character for
 * one, so that a match found in what is compared is where it is in the note.
 */
function fold(char: string): string {
  let folded = char.normalize("NFKC");
  if ([...folded].length !== 1) folded = char;
  folded = folded.toLowerCase();
  const code = folded.codePointAt(0)!;
  // ァ..ヶ to ぁ..ゖ.
  if (code >= 0x30a1 && code <= 0x30f6) folded = String.fromCodePoint(code - 0x60);
  return [...folded].length === 1 ? folded : char;
}

/** Every place `query` is in the note's text, in order: within a line, not across two. */
export function findMatches(doc: Node, query: string): Match[] {
  const wanted = [...query].map(fold).join("");
  if (wanted.length === 0) return [];
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // The line's text, folded, and where each of its characters is.
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (!child.isText) return;
      let index = 0;
      for (const char of child.text!) {
        const folded = fold(char);
        text += folded;
        // A character of two code units (an emoji, say) is two positions.
        for (let unit = 0; unit < folded.length; unit += 1) {
          at.push(pos + 1 + offset + index + Math.min(unit, char.length - 1));
        }
        index += char.length;
      }
    });
    let from = text.indexOf(wanted);
    while (from >= 0) {
      const last = from + wanted.length - 1;
      matches.push({ from: at[from]!, to: at[last]! + 1 });
      from = text.indexOf(wanted, from + wanted.length);
    }
    return false;
  });
  return matches;
}

function decorate(doc: Node, matches: Match[], current: number): DecorationSet {
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === current ? "memoca-find-match memoca-find-current" : "memoca-find-match",
      }),
    ),
  );
}

const EMPTY: FindState = { query: "", current: 0, matches: [], decorations: DecorationSet.empty };

/** What the find bar shows: how many there are, and which is the one on (from 0). */
export function findStatus(state: EditorState): { count: number; current: number } {
  const found = key.getState(state) ?? EMPTY;
  return { count: found.matches.length, current: found.current };
}

/** Looks for `query` in the note, the match on being the first at or after the caret. */
export function setFindQuery(view: EditorView, query: string): void {
  view.dispatch(view.state.tr.setMeta(key, { query, from: view.state.selection.from }));
}

/** Moves to the next match (1) or the one before (-1), round from the last to the first. */
export function stepFind(view: EditorView, direction: 1 | -1): void {
  view.dispatch(view.state.tr.setMeta(key, { step: direction }));
}

/** Stops looking: the marks gone, and the match on (if any) selected, as a browser's find leaves it. */
export function endFind(view: EditorView, select: boolean): void {
  const found = key.getState(view.state) ?? EMPTY;
  const match = found.matches[found.current];
  const tr = view.state.tr.setMeta(key, { query: "" });
  if (select && match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to));
  view.dispatch(tr);
}

/**
 * Finding in the note (⌘F / Ctrl+F, see FindBar): the matches marked, the one
 * on more strongly, as the note is changed too.
 */
export const findInNote = createExtension(() => ({
  key: "memocaFind",
  prosemirrorPlugins: [
    new Plugin<FindState>({
      key,
      state: {
        init: () => EMPTY,
        apply(tr, previous, _old, state) {
          const meta = tr.getMeta(key) as { query?: string; from?: number; step?: 1 | -1 } | undefined;
          if (meta?.query !== undefined) {
            if (meta.query === "") return EMPTY;
            const matches = findMatches(state.doc, meta.query);
            const after = matches.findIndex((match) => match.from >= (meta.from ?? 0));
            const current = after < 0 ? 0 : after;
            return { query: meta.query, current, matches, decorations: decorate(state.doc, matches, current) };
          }
          if (meta?.step && previous.matches.length > 0) {
            const count = previous.matches.length;
            const current = (previous.current + meta.step + count) % count;
            return { ...previous, current, decorations: decorate(state.doc, previous.matches, current) };
          }
          if (!tr.docChanged || previous.query === "") return previous;
          // Written in while looking: found again, the one on kept as near as it can be.
          const matches = findMatches(state.doc, previous.query);
          const current = Math.min(previous.current, Math.max(matches.length - 1, 0));
          return { ...previous, current, matches, decorations: decorate(state.doc, matches, current) };
        },
      },
      props: {
        decorations: (state) => key.getState(state)?.decorations ?? DecorationSet.empty,
      },
    }),
  ],
}));
