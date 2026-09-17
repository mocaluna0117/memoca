import type { Stamp } from "@/lib/types";

/**
 * Mirror of the comparison in `convex/lib/hlc.ts`. The two must agree, because
 * the client merges incoming rows with exactly the rule the server applied.
 */
export function isNewer(candidate: Stamp, current: Stamp): boolean {
  if (candidate.t !== current.t) return candidate.t > current.t;
  return candidate.d > current.d;
}

export const ZERO_STAMP: Stamp = { t: 0, d: "" };
