"use client";

import { getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import type { Stamp } from "@/lib/types";

let offset = 0;
let last = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Mirror of the server's MAX_CLOCK_SKEW_MS: a stamp further ahead of its clock is refused. */
const CLOCK_SKEW_MS = 60_000;

export async function loadClock(): Promise<void> {
  offset = await getMeta(META.clockOffset, 0);
  last = await getMeta(META.lastHlc, 0);
  leaveTheFuture();
}

/**
 * Corrects for a device clock that is wrong.
 *
 * The server refuses stamps more than a minute in the future, because a fast
 * clock would otherwise win every last-writer-wins comparison for as long as it
 * stayed wrong. Rather than have those writes fail, every response carries the
 * server's time and the client shifts its own stamps to match.
 */
export function syncClock(serverTime: number): void {
  const next = serverTime - Date.now();
  if (Math.abs(next - offset) >= 1_000) {
    offset = next;
    void setMeta(META.clockOffset, offset);
  }
  leaveTheFuture();
}

/**
 * The last stamp, left where a clock that ran ahead put it, would hold
 * every stamp from now on there too (each is made after the last), to be
 * refused for as long as real time took to catch up: a new note made
 * meanwhile would never reach the server. Brought back to within what the
 * server allows of the corrected time. Half of it: a stamp taken in just
 * before, up to the full minute ahead, is more likely still behind it.
 */
function leaveTheFuture(): void {
  const corrected = Date.now() + offset;
  if (last <= corrected + CLOCK_SKEW_MS) return;
  last = corrected + CLOCK_SKEW_MS / 2;
  void setMeta(META.lastHlc, last);
}

/** A stamp that never repeats and never goes backwards on this device. */
export function stamp(deviceId: string): Stamp {
  const now = Date.now() + offset;
  last = Math.max(now, last + 1);
  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void setMeta(META.lastHlc, last);
    }, 2_000);
  }
  return { t: last, d: deviceId };
}

export function clockOffset(): number {
  return offset;
}
