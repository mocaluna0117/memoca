"use client";

import { getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import type { Stamp } from "@/lib/types";

let offset = 0;
let last = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadClock(): Promise<void> {
  offset = await getMeta(META.clockOffset, 0);
  last = await getMeta(META.lastHlc, 0);
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
  if (Math.abs(next - offset) < 1_000) return;
  offset = next;
  void setMeta(META.clockOffset, offset);
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
