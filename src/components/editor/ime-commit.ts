import { createExtension } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { traceIme } from "@/lib/debug/ime-trace";

/** A line as far as this needs it. */
type Line = { id: string; content?: unknown; children: unknown[] };

/**
 * The line a commit of a word from the input method made, if it left the
 * caret in a new line next to the one the word was written in, and that one;
 * {@link settleWord} says what to do with them. Null when nothing needs
 * putting right.
 *
 * In the Mac desktop app's WebKit, committing a word first deletes the word
 * being composed. A line alone in its group (an item indented under another,
 * the only line inside a toggle) is then left empty, and WebKit takes it out
 * of the page altogether. ProseMirror takes what is left for a new line and
 * plays an Enter for it, which splits the line; the caret goes to the new
 * one, and the word chosen with it. The line the word was written in stays,
 * with the word or empty. (Safari does not delete the word first, so the web
 * app never did this.)
 *
 * Only a line the composition made: one there before it (the next line,
 * clicked or tapped while a word was still being written, which ends the
 * composition there) is the person's own, and stays as it is.
 */
export function strayLine(
  started: string | null,
  now: Line | undefined,
  before: Line | undefined,
  wasThere: (id: string) => boolean,
): { keep: string; drop: string } | null {
  if (!started || !now || now.id === started || wasThere(now.id)) return null;
  // Only the new line right after it, with nothing under it.
  if (!before || before.id !== started || now.children.length > 0) return null;
  return { keep: started, drop: now.id };
}

/**
 * What to do, a commit having made a stray line, by the text of the line the
 * word was written in (`keep`) and of the stray one (`now`), the word
 * committed (`word`, empty for a composition given up) and the last of what
 * was being composed (`composed`). WebKit only takes out a line that held
 * nothing but the composition, so the line the word was written in is to end
 * up with the word alone:
 *
 * - "drop": it has the word already. The stray line goes, with whatever of
 *   the word it has.
 * - "move": it has nothing, or only what was being composed. The stray line's
 *   text (the word, or nothing) goes into it, and the stray line goes.
 * - null: anything else, left as it is rather than lose what was written.
 */
export function settleWord({
  keep,
  now,
  word,
  composed,
}: {
  keep: string;
  now: string;
  word: string;
  composed: string;
}): "drop" | "move" | null {
  if (now !== "" && now !== word) return null;
  if (keep === word) return "drop";
  if (keep !== "" && keep !== composed) return null;
  return now === word ? "move" : null;
}

/** A line's text, anything else in it (a mention) standing in as a character no word has. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "\uFFFC";
  return content
    .map((part: { type?: string; text?: unknown; content?: unknown }) =>
      typeof part.text === "string"
        ? part.text
        : part.type === "link"
          ? textOf(part.content)
          : "\uFFFC",
    )
    .join("");
}

/** The ids of every block in a document. */
function idsOf(doc: Node): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "blockContainer") ids.add(node.attrs.id as string);
    return true;
  });
  return ids;
}

export const imeCommit = createExtension(({ editor }) => ({
  key: "memocaImeCommit",
  mount({ dom, signal }) {
    // WebKit's only: elsewhere a word is committed in its own line.
    if (!/Apple/.test(navigator.vendor)) return;
    let started: string | null = null;
    // The lines there when the composition started.
    let there = new Set<string>();
    // The last of what was being composed.
    let composed = "";
    dom.addEventListener(
      "compositionstart",
      () => {
        started = editor.getTextCursorPosition().block.id;
        there = idsOf(editor.prosemirrorState.doc);
        composed = "";
        traceIme({ type: "ime:start", lines: there.size });
      },
      { signal },
    );
    dom.addEventListener(
      "compositionupdate",
      (event) => {
        composed = (event as CompositionEvent).data ?? "";
      },
      { signal },
    );
    // Taken before it reaches the editor, for this to be put right before
    // the input rules look at the line (・ made a bullet, by japanese-lists),
    // each waiting for the same moment: in the stray line, they would take
    // the word out of it.
    dom.ownerDocument.addEventListener(
      "compositionend",
      (event) => {
        if (!(event.target instanceof globalThis.Node) || !dom.contains(event.target)) return;
        const from = started;
        const wasThere = there;
        const word = (event as CompositionEvent).data ?? "";
        const last = composed;
        started = null;
        there = new Set();
        composed = "";
        // Once ProseMirror has taken in the commit and finished composing.
        setTimeout(() => {
          const view = editor.prosemirrorView;
          if (!view || view.composing) {
            traceIme({ type: "ime:repair", result: view ? "skipped-composing" : "no-view" });
            return;
          }
          const now = editor.getTextCursorPosition().block as Line;
          const before = editor.getPrevBlock(now.id) as Line | undefined;
          const fix = strayLine(from, now, before, (id) => wasThere.has(id));
          const keep = fix ? textOf(editor.getBlock(fix.keep)?.content) : "";
          const nowText = textOf(now.content);
          const settle = fix ? settleWord({ keep, now: nowText, word, composed: last }) : null;
          // What was decided, in counts only: whether the caret moved to
          // another line, a new one, right after the one it started in.
          traceIme({
            type: "ime:repair",
            result: fix ? (settle ?? "unexpected") : "none",
            started: from !== null,
            moved: now.id !== from,
            nowNew: !wasThere.has(now.id),
            afterStarted: before?.id === from,
            children: now.children.length,
            wordLen: word.length,
            composedLen: last.length,
            nowLen: nowText.length,
            keepLen: fix ? keep.length : null,
          });
          if (!fix || !settle) return;
          editor.transact(() => {
            if (settle === "move") editor.updateBlock(fix.keep, { content: now.content } as never);
            editor.removeBlocks([fix.drop]);
            editor.setTextCursorPosition(fix.keep, "end");
          });
        });
      },
      { capture: true, signal },
    );
  },
}));
