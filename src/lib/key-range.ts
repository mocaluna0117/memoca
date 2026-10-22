/**
 * Bounds for reading every row of a table but one, by its key, so that
 * Dexie's liveQuery does not run the query again for writes to that one row.
 *
 * liveQuery runs a query again for a write to a key in the ranges it read,
 * and takes a range as closed, its ends included, whatever the query asked:
 * `below(key)` and `above(key)` are watched as ranges that include `key`
 * itself. These are ranges that leave it out, ends included.
 */

/** The smallest string above `key`: every key above `key` is at or above it. */
export function justAbove(key: string): string {
  return `${key}\u0000`;
}

/**
 * A string below `key` that every key below `key` is at or below, for keys
 * with no U+FFFF in them: the ids here are ASCII (UUIDs, and a day's note's
 * id, made of its date).
 */
export function justBelow(key: string): string {
  const last = key.charCodeAt(key.length - 1);
  return `${key.slice(0, -1)}${String.fromCharCode(last - 1)}￿`;
}
