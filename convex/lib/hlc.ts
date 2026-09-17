import { MAX_CLOCK_SKEW_MS } from "./constants";

export type Stamp = { t: number; d: string };

/**
 * Last-writer-wins comparison. The device id breaks ties so that two devices
 * stamping the same millisecond still converge on the same winner.
 */
export function isNewer(candidate: Stamp, current: Stamp): boolean {
  if (candidate.t !== current.t) return candidate.t > current.t;
  return candidate.d > current.d;
}

/**
 * A device whose clock runs fast would win every future comparison, so we
 * refuse stamps from the future and let the client re-stamp with an offset.
 */
export function isFromTheFuture(stamp: Stamp, now: number): boolean {
  return stamp.t > now + MAX_CLOCK_SKEW_MS;
}

export const ZERO_STAMP: Stamp = { t: 0, d: "" };
