"use client";

import type { Stamp } from "@/lib/types";
import { stamp } from "./clock";

/** The stamp groups an op of each kind carries, by the key under which each sits in it. */
const GROUPS: Record<string, readonly string[]> = {
  folder: ["name", "place", "trash"],
  note: ["title", "preview", "place", "pin", "pinPlace", "trash"],
};

/** A stamp of an op, as it was and as it is now; `group` names it on the local row's `ts` too. */
export type Restamped = { group: string; was: Stamp; now: Stamp };

/**
 * The op's stamps made anew by the clock as it is now corrected. The server
 * refused them as from the future: the device's clock had run ahead when
 * they were made. Sent again as they are, they would be refused again, and
 * dropped the op would take what it carries (a note's making, a rename)
 * with it. What changed is returned too, for the local row to follow: kept
 * ahead, a later edit from elsewhere would lose here while winning on the
 * server.
 */
export function restampOp(
  payload: Record<string, unknown>,
  device: string,
): { payload: Record<string, unknown>; changed: Restamped[] } {
  const changed: Restamped[] = [];
  const next: Record<string, unknown> = { ...payload };
  for (const group of GROUPS[String(payload.kind)] ?? []) {
    const field = payload[group] as { ts?: Stamp } | undefined;
    if (!field?.ts) continue;
    const now = stamp(device);
    changed.push({ group, was: field.ts, now });
    next[group] = { ...field, ts: now };
  }
  // A note made locked carries its lock's stamp inside `create`.
  const create = payload.create as { lock?: { ts: Stamp } } | undefined;
  if (create?.lock?.ts) {
    const now = stamp(device);
    changed.push({ group: "lock", was: create.lock.ts, now });
    next.create = { ...create, lock: { ...create.lock, ts: now } };
  }
  return { payload: next, changed };
}
