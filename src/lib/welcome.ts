"use client";

import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { SCHEMA } from "@/components/editor/schema";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { createNote } from "@/lib/sync/mutations";
import { bodyFragment } from "@/lib/sync/ydoc";

/**
 * The app's welcome for someone new to it: a few cards as they first come
 * in (components/onboarding/welcome-tour), once an account, and, for an
 * account just made, a note in its Inbox to try things in.
 */

/**
 * On this device, no welcome at all, nor a note to try things in: for the
 * tests, whose every run is a new account (e2e/helpers.ts), and anyone who
 * would rather not.
 */
export const WELCOME_OFF = "memoca:welcome-off";

/** Seen on this device by this account: not shown again while the server is still to hear of it. */
const seenKey = (userKey: string) => `memoca:welcome-seen:${userKey}`;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const welcomeOff = () => read(WELCOME_OFF) === "1";
export const welcomeSeenHere = (userKey: string) => read(seenKey(userKey)) === "1";
export function rememberWelcomeSeen(userKey: string): void {
  try {
    localStorage.setItem(seenKey(userKey), "1");
  } catch {
    // Shown again here only until the server has heard of it.
  }
}

/** The title of the note made to try things in. */
export const PRACTICE_TITLE = "はじめに読むメモ";

const text = (value: string) => [{ type: "text" as const, text: value, styles: {} }];

/** What the note to try things in says: things to do, ticked as they are, and how lines are written. */
export const PRACTICE_BLOCKS: PartialBlock[] = [
  {
    type: "paragraph",
    content: text("Memoca へようこそ。このメモは練習用です。書き換えても、消してもかまいません。"),
  },
  { type: "heading", props: { level: 2 }, content: text("やってみよう") },
  {
    type: "checkListItem",
    content: text("サイドバーの「フォルダ」の横の、＋ の付いた紙のボタン（メモを追加）で、メモを 1 つ作ってみる"),
  },
  {
    type: "checkListItem",
    content: text("行のはじめに「- 」（ハイフンと空白）と打って、箇条書きにしてみる"),
  },
  {
    type: "checkListItem",
    content: text("「/」（スラッシュ）を打って、出てきたメニューから見出しやチェックリストを選んでみる"),
  },
  {
    type: "checkListItem",
    content: text("⚡ 即席メモを開いて、思いついたことをすぐ書いてみる"),
  },
  {
    type: "checkListItem",
    content: text("スマホやほかのパソコンでも、同じアカウントでログインしてみる（同じメモが見られます）"),
  },
  {
    type: "paragraph",
    content: text("できたら、左の □ を押してチェックを付けましょう。"),
  },
  { type: "heading", props: { level: 2 }, content: text("書き方の例") },
  { type: "bulletListItem", content: text("箇条書き：行のはじめに「- 」") },
  { type: "numberedListItem", content: text("番号付き：行のはじめに「1. 」") },
  { type: "checkListItem", content: text("チェック項目：行のはじめに「[] 」") },
  { type: "quote", content: text("引用：行のはじめに「> 」") },
  {
    type: "paragraph",
    content: text("見出しは「# 」（シャープと空白）です。日本語入力がオンのままでも、「ー」のあとに空白で箇条書き、「１．」のあとに空白で番号付きになります。"),
  },
  { type: "heading", props: { level: 2 }, content: text("くわしい使い方") },
  {
    type: "paragraph",
    content: text("サイドバーのいちばん下の「？」（使い方）から、いつでも見られます。"),
  },
];

/**
 * Makes the note to try things in, in the Inbox of an account just made:
 * as any note is (saved, and sent), with a new id. Its id.
 */
export async function createPracticeNote(inboxFolderId: string | null): Promise<string> {
  const noteId = await createNote({ folderId: inboxFolderId, title: PRACTICE_TITLE });
  const editor = BlockNoteEditor.create({ schema: SCHEMA });
  const doc = await acquireDoc(noteId);
  try {
    doc.transact(() => blocksToYXmlFragment(editor as never, PRACTICE_BLOCKS as never, bodyFragment(doc)));
  } finally {
    await releaseDoc(noteId);
  }
  return noteId;
}
