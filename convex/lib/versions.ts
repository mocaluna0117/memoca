/** How often, at most, a version of a note is kept while it is edited. */
export const VERSION_GAP_MS = 10 * 60 * 1000;
/** How long versions are kept. */
export const VERSION_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The newest versions, kept whatever their age. */
const NEWEST_KEPT = 6;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Of a note's versions, those to let go of: all past 30 days; of the rest,
 * beyond the six newest, the newest of each hour of the last day, and the
 * newest of each day before that. Fewer kept the older they are, as one
 * looks back further only for something lost longer ago.
 */
export function versionsToDrop<T extends { createdAt: number }>(versions: T[], now: number): T[] {
  const newestFirst = [...versions].sort((a, b) => b.createdAt - a.createdAt);
  const buckets = new Set<string>();
  const drop: T[] = [];
  newestFirst.forEach((version, index) => {
    const age = now - version.createdAt;
    if (age > VERSION_KEEP_MS) {
      drop.push(version);
      return;
    }
    if (index < NEWEST_KEPT) return;
    const bucket =
      age < DAY
        ? `h${Math.floor(version.createdAt / HOUR)}`
        : `d${Math.floor(version.createdAt / DAY)}`;
    if (buckets.has(bucket)) drop.push(version);
    else buckets.add(bucket);
  });
  return drop;
}
