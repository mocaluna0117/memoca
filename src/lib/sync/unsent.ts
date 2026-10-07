"use client";

import { db } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { type QuickDraft, unsaved } from "@/lib/quick/draft";

/**
 * What only this device has: changes not sent to the server yet, files not
 * uploaded yet, and quick notes written but not saved. Signing out (or
 * anything else that clears the device) would lose it for good: nowhere
 * else has it. While the server takes writes they are seconds old; while it
 * does not (no network, or the Convex plan's limits reached), they pile up.
 */
export type Unsent = { changes: number; files: number; quickNotes: number };

export async function unsentOnDevice(): Promise<Unsent> {
  const database = db();
  const [changes, files, drafts] = await Promise.all([
    database.outbox.count(),
    database.pendingUploads.count(),
    database.meta.where("key").startsWith(`${META.quickDraft}:`).toArray(),
  ]);
  const quickNotes = drafts.filter((row) => {
    const draft = row.value as QuickDraft | null;
    return draft && unsaved({ text: draft.text, images: draft.images ?? [], saved: draft.saved });
  }).length;
  return { changes, files, quickNotes };
}

/** Whether anything would be lost. */
export const anyUnsent = (unsent: Unsent) => unsent.changes + unsent.files + unsent.quickNotes > 0;

/** What would be lost, said as a list. */
export function unsentLines(unsent: Unsent): string[] {
  return [
    unsent.changes > 0 ? `サーバーに送っていない変更 ${unsent.changes} 件` : null,
    unsent.files > 0 ? `アップロードしていない画像・ファイル ${unsent.files} 件` : null,
    unsent.quickNotes > 0 ? `保存していない即席メモ ${unsent.quickNotes} 件` : null,
  ].filter((line): line is string => line !== null);
}
