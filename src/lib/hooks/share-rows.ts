/**
 * Rows read again from the local database, given back as the same objects
 * where nothing in them changed.
 *
 * Dexie reads every row afresh, as new objects, each time a query runs again,
 * and a query over the notes runs again on any write to the table: typing in
 * a note writes it every flush, and its echo from the server writes it again.
 * A list that is handed 150 new objects then draws all 150 rows again, for
 * one note changed. Kept, an unchanged row stays the same object, a memoized
 * row is not drawn again, and a result with nothing changed in it is the
 * previous array itself, which useLiveQuery does not render again for.
 */

/** Whether two values read from IndexedDB hold the same data. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  // By kind, as a tag: a copy can come from another realm (a worker's, a
  // test's), whose constructors are not these.
  const kind = Object.prototype.toString.call(a);
  if (kind !== Object.prototype.toString.call(b)) return false;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    return sameBytes(
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
    );
  }
  if (kind === "[object ArrayBuffer]") {
    const [x, y] = [a as ArrayBuffer, b as ArrayBuffer];
    return x.byteLength === y.byteLength && sameBytes(new Uint8Array(x), new Uint8Array(y));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  // Rows hold nothing else but plain objects: anything else (a Date, a Map,
  // a Blob) is taken to have changed.
  if (kind !== "[object Object]") return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** `next`, or `previous` itself where it holds the same data. */
export function shareRow<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && sameValue(previous, next) ? previous : next;
}

/**
 * `next`, with each row that holds the same data as the one of its key in
 * `previous` given back as that object; and `previous` itself when every row
 * is the same, in the same order.
 */
export function shareRows<T>(
  previous: readonly T[] | undefined,
  next: T[],
  keyOf: (row: T) => string,
): T[] {
  if (!previous || previous.length === 0) return next;
  const before = new Map<string, T>();
  for (const row of previous) before.set(keyOf(row), row);
  let unchanged = previous.length === next.length;
  const shared = next.map((row, index) => {
    const kept = before.get(keyOf(row));
    const result = kept !== undefined && sameValue(kept, row) ? kept : row;
    if (result !== previous[index]) unchanged = false;
    return result;
  });
  return unchanged ? (previous as T[]) : shared;
}
