"use client";

import { type BlockNoteEditor, createExtension } from "@blocknote/core";
import { isHiddenNote } from "@/lib/quick/todo-id";
import { SuggestionMenu } from "@blocknote/core/extensions";
import { SuggestionMenuController } from "@blocknote/react";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { FileText, Link2 } from "lucide-react";
import { db } from "@/lib/db";
import { noteLink } from "@/lib/note-links";
import { noteName } from "@/lib/note-name";

/** What opens the menu of notes to link to: [[, as in other note apps. */
export const LINK_TRIGGER = "[[";
/** The same typed with the input method on, which makes [ a 「. */
const LINK_TRIGGER_JA = "「「";

/** The notes a link may go to, whose name has `query` in it: the newest first, not this one. */
async function notesFor(noteId: string, query: string) {
  const wanted = query.trim().toLowerCase();
  const notes = (await db().notes.orderBy("updatedAt").reverse().toArray())
    .filter(
      (note) =>
        note.noteId !== noteId &&
        !note.deletedAt &&
        !note.purged &&
        !note.locked &&
        !isHiddenNote(note.noteId),
    )
    .map((note) => ({ note, name: noteName(note.title, note.preview).text }))
    .filter(({ name }) => !wanted || name.toLowerCase().includes(wanted));
  return notes.slice(0, 20);
}

/** A link to a note, at the caret, named as the note is, with a space after it to go on typing. */
export function insertNoteLink(editor: BlockNoteEditor, noteId: string, name: string) {
  editor.insertInlineContent([
    { type: "link", href: noteLink(noteId), content: name },
    " ",
  ] as never);
}

/** Opens the menu of notes to link to, as typing [[ does: for the / menu's メモへのリンク. */
export function openNoteLinkMenu(editor: BlockNoteEditor) {
  editor.getExtension(SuggestionMenu)?.openSuggestionMenu(LINK_TRIGGER, {
    deleteTriggerCharacter: true,
    ignoreQueryLength: true,
  });
}

/**
 * Where the [[ put in for a 「「 starts, while the menu it opened is open:
 * mapped through every change after it.
 */
const fromJa = new PluginKey<number | null>("memocaNoteLinkFromJa");

/** Whether BlockNote's menu (the / one, or [['s) is open: its plugin's state, set only then. */
const menuOpen = (state: EditorState) =>
  state.plugins
    .find((plugin) => (plugin as unknown as { key: string }).key === "SuggestionMenuPlugin$")
    ?.getState(state) !== undefined;

/**
 * [[, typed with the input method on, comes as 「「, committed at once and
 * not as typing, which the menu does not hear: once it is committed, the
 * 「「 goes and the menu opens, as for [[.
 */
export const noteLinkInput = createExtension(({ editor }) => ({
  key: "memocaNoteLinkInput",
  mount({ dom, signal }) {
    dom.addEventListener(
      "compositionend",
      () => {
        setTimeout(() => {
          const view = editor.prosemirrorView;
          if (!view || view.composing) return;
          const { $from, empty } = view.state.selection;
          if (!empty || $from.parent.type.spec.code) return;
          const before = $from.parent.textBetween(
            Math.max(0, $from.parentOffset - LINK_TRIGGER_JA.length),
            $from.parentOffset,
          );
          if (before !== LINK_TRIGGER_JA) return;
          const at = $from.pos - LINK_TRIGGER_JA.length;
          view.dispatch(view.state.tr.delete(at, $from.pos));
          openNoteLinkMenu(editor as unknown as BlockNoteEditor);
          view.dispatch(view.state.tr.setMeta(fromJa, at));
        });
      },
      { signal },
    );
  },
  // The menu closed with no note chosen (Esc, the caret moved away): the
  // 「「 that was typed back in place of the [[ put in for it, and what was
  // typed after it kept. It was left [[, which was never typed.
  prosemirrorPlugins: [
    new Plugin<number | null>({
      key: fromJa,
      state: {
        init: () => null,
        apply: (tr, at) => {
          const set = tr.getMeta(fromJa) as number | null | undefined;
          if (set !== undefined) return set;
          if (at === null) return null;
          const mapped = tr.mapping.mapResult(at, 1);
          return mapped.deleted ? null : mapped.pos;
        },
      },
      view: () => ({
        update(view) {
          const at = fromJa.getState(view.state);
          if (at == null || menuOpen(view.state)) return;
          // After this update, not inside it.
          queueMicrotask(() => {
            if (fromJa.getState(view.state) !== at || menuOpen(view.state)) return;
            view.dispatch(backToJa(view.state, at));
          });
        },
      }),
    }),
  ],
}));

/** The [[ at `at`, if it is still there, made 「「 again; the marker let go of. */
function backToJa(state: EditorState, at: number) {
  const tr = state.tr.setMeta(fromJa, null);
  const end = at + LINK_TRIGGER.length;
  if (end <= tr.doc.content.size && tr.doc.textBetween(at, end) === LINK_TRIGGER) {
    tr.insertText(LINK_TRIGGER_JA, at, end);
  }
  return tr;
}

/** The menu [[ opens: the notes to link to, by name. */
export function NoteLinkMenu({ editor, noteId }: { editor: BlockNoteEditor; noteId: string }) {
  return (
    <SuggestionMenuController
      triggerCharacter={LINK_TRIGGER}
      shouldOpen={(state) => !state.selection.$from.parent.type.spec.code}
      getItems={async (query) => {
        const found = await notesFor(noteId, query);
        // None: no item, not one that says so. An item, any item, takes
        // the Enter (and a click), and with it what was typed from the [[
        // on: 「前置き [[あとで書く」 and Enter left 「前置き 」, with no new
        // line. With none, the menu says nothing is found, Enter is the
        // editor's, and the menu closes as the typing goes on.
        if (found.length === 0) return [];
        return found.map(({ note, name }) => ({
          title: name,
          icon: <FileText size={18} />,
          onItemClick: () => insertNoteLink(editor, note.noteId, name),
        }));
      }}
    />
  );
}

/** メモへのリンク, in the / menu: opens the menu of notes to link to. */
export function noteLinkSlashItem(editor: BlockNoteEditor) {
  return {
    title: "メモへのリンク",
    subtext: "ほかのメモへのリンクを入れる（[[ でも開けます）",
    aliases: ["link", "リンク", "りんく", "メモ", "[["],
    group: "その他",
    icon: <Link2 size={18} />,
    onItemClick: () => openNoteLinkMenu(editor),
  };
}
