"use client";

/**
 * Watches over the quick note's field for the two ways it has been seen to
 * stop taking what is typed in the Mac desktop app under a heavy load
 * (Zoom on, little memory left), until the window was put away and brought
 * out again:
 *
 * - What the field holds and what the app was told of it come apart (an
 *   `input` event lost, or thrown out of): told again from the field, which
 *   is what is on the screen, and so what counts.
 * - A composition (a word being converted) that never ends: each key then
 *   replaces the character after the caret, nothing can be deleted, and no
 *   `input` reaches the app. Seen by keys that say they are composing
 *   (`isComposing`, or keyCode 229) with no `compositionupdate` or `input`
 *   for a while, the field is blurred and focused, which is what putting the
 *   window away and bringing it out did.
 *
 * Both are noted in the input record (debug/ime-trace), for the cause to
 * be found from it. Returns what stops the watch.
 */
export function attachFieldWatchdog(
  field: HTMLTextAreaElement,
  {
    told,
    resync,
    trace,
    stallMs = STALL_MS,
    everyMs = CHECK_MS,
  }: {
    /** The text the app holds for the field. */
    told: () => string;
    /** Tells the app the field's text, where the two came apart. */
    resync: (value: string) => void;
    /** The input record (debug/ime-trace's traceIme). */
    trace: (entry: Record<string, string | number | boolean | null>) => void;
    stallMs?: number;
    everyMs?: number;
  },
): () => void {
  let composing = false;
  let stalledKeys = 0;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let lastShake = 0;

  const check = () => {
    const value = field.value;
    if (value === told()) return;
    trace({ type: "quick:desync", fieldLen: value.length, toldLen: told().length });
    resync(value);
  };
  const soon = () => queueMicrotask(check);

  const clearStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    stalledKeys = 0;
  };
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!composing || stalledKeys < STALL_KEYS) return;
      trace({ type: "quick:stuck-composition", keys: stalledKeys });
      stalledKeys = 0;
      // At most now and then: a composition that is only slow is left alone.
      if (Date.now() - lastShake < SHAKE_EVERY_MS) return;
      lastShake = Date.now();
      composing = false;
      field.blur();
      field.focus();
    }, stallMs);
  };

  const onCompositionStart = () => {
    composing = true;
    stalledKeys = 0;
    armStall();
  };
  const onCompositionUpdate = () => {
    stalledKeys = 0;
    armStall();
  };
  const onCompositionEnd = () => {
    composing = false;
    clearStall();
    soon();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!composing) return;
    if (event.isComposing || event.keyCode === 229) {
      stalledKeys += 1;
      if (!stallTimer) armStall();
    }
  };
  const onInput = () => {
    stalledKeys = 0;
    if (composing) armStall();
    soon();
  };

  field.addEventListener("compositionstart", onCompositionStart);
  field.addEventListener("compositionupdate", onCompositionUpdate);
  field.addEventListener("compositionend", onCompositionEnd);
  field.addEventListener("keydown", onKeyDown);
  field.addEventListener("keyup", soon);
  field.addEventListener("input", onInput);
  // Now and then while it has the focus, for an event that never came. A
  // timeout armed again each time, not an interval: the one kind of timer
  // the app's tests fake.
  let every: ReturnType<typeof setTimeout> | null = null;
  const again = () => {
    every = setTimeout(() => {
      if (document.activeElement === field && !composing) check();
      again();
    }, everyMs);
  };
  again();

  return () => {
    clearStall();
    if (every) clearTimeout(every);
    field.removeEventListener("compositionstart", onCompositionStart);
    field.removeEventListener("compositionupdate", onCompositionUpdate);
    field.removeEventListener("compositionend", onCompositionEnd);
    field.removeEventListener("keydown", onKeyDown);
    field.removeEventListener("keyup", soon);
    field.removeEventListener("input", onInput);
  };
}

/** How long a composition may go without a word of it before it counts as stuck. */
export const STALL_MS = 2_000;
/** Keys said to be composing, with nothing composed, before it counts. */
export const STALL_KEYS = 3;
/** How often the field is checked against what the app holds, while focused. */
export const CHECK_MS = 1_000;
/** How often, at most, a stuck field is blurred and focused. */
export const SHAKE_EVERY_MS = 5_000;
