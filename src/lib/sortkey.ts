const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Fractional index keys, so reordering one item writes one row.
 *
 * Positions are strings that always have room for another string between any
 * two of them. Dragging a note between two others therefore never renumbers
 * its neighbours, which matters a lot when every write is a sync operation.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new Error(`sort keys out of order: ${a} >= ${b}`);
  }
  if (a.slice(-1) === "0" || (b !== null && b.slice(-1) === "0")) {
    throw new Error("sort keys must not end in the lowest digit");
  }
  if (b !== null) {
    let common = 0;
    while ((a[common] ?? "0") === b[common]) common += 1;
    if (common > 0) {
      return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
    }
  }
  const low = a === "" ? 0 : DIGITS.indexOf(a[0]!);
  const high = b === null ? DIGITS.length : DIGITS.indexOf(b[0]!);
  if (high - low > 1) return DIGITS[Math.round(0.5 * (low + high))]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low]! + midpoint(a.slice(1), null);
}

export function between(before: string | null, after: string | null): string {
  return midpoint(before ?? "", after);
}

export const FIRST_KEY = between(null, null);

export function sortByKey<T extends { sortKey: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.sortKey === b.sortKey ? 0 : a.sortKey < b.sortKey ? -1 : 1,
  );
}
