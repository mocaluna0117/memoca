"use client";

import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";

/** What was being written in the quick note, kept on this device until it is saved. */
export type QuickDraft = { text: string; updatedAt: number };

/** How long typing has to pause before the draft is written. */
export const DRAFT_DELAY_MS = 300;

export const loadDraft = () => getMeta<QuickDraft | null>(META.quickDraft, null);

export const clearDraft = () => db().meta.delete(META.quickDraft);

/** Writes the draft, or forgets it once there is nothing in it. */
function writeDraft(text: string): Promise<void> {
  return text.trim() === ""
    ? clearDraft()
    : setMeta(META.quickDraft, { text, updatedAt: Date.now() } satisfies QuickDraft);
}

/**
 * Keeps the quick note's draft as it is typed: written once typing pauses,
 * and at once when the page goes out of sight or away, which on a phone can
 * be the last the page ever runs.
 */
export function keepDraft(): {
  update(text: string): void;
  /** Writes what is waiting now, if anything is. */
  flush(): Promise<void>;
  /** Drops what is waiting: it has been saved as a note. */
  cancel(): void;
  dispose(): void;
} {
  let waiting: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flush = async () => {
    stop();
    if (waiting === null) return;
    const text = waiting;
    waiting = null;
    await writeDraft(text);
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") void flush();
  };
  const onLeave = () => void flush();
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onLeave);
  return {
    update(text) {
      waiting = text;
      stop();
      timer = setTimeout(() => void flush(), DRAFT_DELAY_MS);
    },
    flush,
    cancel() {
      stop();
      waiting = null;
    },
    dispose() {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeave);
      void flush();
    },
  };
}
