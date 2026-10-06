"use client";

import { type BlockNoteEditor, createExtension } from "@blocknote/core";
import { SuggestionMenu } from "@blocknote/core/extensions";
import { SuggestionMenuController } from "@blocknote/react";
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
    .filter((note) => note.noteId !== noteId && !note.deletedAt && !note.purged && !note.locked)
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
          view.dispatch(view.state.tr.delete($from.pos - LINK_TRIGGER_JA.length, $from.pos));
          openNoteLinkMenu(editor as unknown as BlockNoteEditor);
        });
      },
      { signal },
    );
  },
}));

/** The menu [[ opens: the notes to link to, by name. */
export function NoteLinkMenu({ editor, noteId }: { editor: BlockNoteEditor; noteId: string }) {
  return (
    <SuggestionMenuController
      triggerCharacter={LINK_TRIGGER}
      shouldOpen={(state) => !state.selection.$from.parent.type.spec.code}
      getItems={async (query) => {
        const found = await notesFor(noteId, query);
        if (found.length === 0) {
          return [
            {
              title: "リンクできるメモがありません",
              subtext: query ? `「${query}」を名前に含むメモはありません` : undefined,
              icon: <Link2 size={18} />,
              onItemClick: () => {},
            },
          ];
        }
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
