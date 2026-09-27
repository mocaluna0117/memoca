"use client";

import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";

/**
 * What was being written in the quick note, kept on this device until it is
 * saved, with the account it was written in: another account signed in on
 * the same device is never shown it.
 */
export type QuickDraft = { text: string; updatedAt: number; userKey: string };

/** How long typing has to pause before the draft is written. */
export const DRAFT_DELAY_MS = 300;

/** The draft this account left on this device, if any. */
export async function loadDraft(userKey: string): Promise<QuickDraft | null> {
  const draft = await getMeta<QuickDraft | null>(META.quickDraft, null);
  return draft && draft.userKey === userKey ? draft : null;
}

export const clearDraft = () => db().meta.delete(META.quickDraft);

/** Writes the draft, or forgets it once there is nothing in it. */
function writeDraft(text: string, userKey: string): Promise<void> {
  return text.trim() === ""
    ? clearDraft()
    : setMeta(META.quickDraft, { text, updatedAt: Date.now(), userKey } satisfies QuickDraft);
}

/**
 * Keeps the quick note's draft as it is typed: written once typing pauses,
 * and at once when the page goes out of sight or away, which on a phone can
 * be the last the page ever runs; then whatever the field holds is written,
 * even what another window wrote over meanwhile.
 *
 * Nothing is written until {@link release}: until the draft already on the
 * device has been read and offered, writing would put it out of reach.
 */
export function keepDraft(userKey: string): {
  update(text: string): void;
  /** The draft on the device has been read: writing may start. */
  release(): void;
  /** Writes what the field holds now; `always`, even if it was written already. */
  flush(always?: boolean): Promise<void>;
  /** The field's text has been saved as a note: it is not a draft any more. */
  cancel(): void;
  dispose(): void;
} {
  let held = true;
  /** What the field holds, as last told; null once it has been saved. */
  let latest: string | null = null;
  /** What this window last wrote. */
  let written: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flush = async (always = false) => {
    stop();
    if (held || latest === null || (!always && latest === written)) return;
    const text = latest;
    written = text;
    await writeDraft(text, userKey);
  };
  const schedule = () => {
    stop();
    if (!held) timer = setTimeout(() => void flush(), DRAFT_DELAY_MS);
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") void flush(true);
  };
  const onLeave = () => void flush(true);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onLeave);
  return {
    update(text) {
      latest = text;
      schedule();
    },
    release() {
      held = false;
      if (latest !== null && latest !== written) schedule();
    },
    flush,
    cancel() {
      stop();
      latest = null;
      written = null;
    },
    dispose() {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeave);
      void flush(true);
    },
  };
}
