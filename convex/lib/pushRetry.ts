/**
 * A reminder its push service did not take, tried again: once a minute,
 * then two, then three after, while the service is busy (429), failing on
 * its side (5xx) or not reached at all. Swallowed before, the reminder was
 * lost for good on a moment's trouble.
 */
export const PUSH_TRIES = 4;

/** How long before try `attempt` (from 1, the first again). */
export const againAfterMs = (attempt: number) => attempt * 60_000;

/** Whether a failure is worth trying again: not a device gone (404, 410), nor one refused for good (4xx). */
export function worthAgain(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}
