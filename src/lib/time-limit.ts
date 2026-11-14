/**
 * Network steps given a time to answer in: one that never answers (a weak
 * signal, a server not reached) otherwise held what waited on it for good,
 * the vault kept open by a lock that would not end, its spinner turning.
 */

/** Thrown when a step took longer than it was given. */
export class TookTooLong extends Error {
  constructor(what: string) {
    super(`${what} took too long`);
    this.name = "TookTooLong";
  }
}

/** The promise's answer, or TookTooLong after `ms`. What it was doing is not called off. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TookTooLong(what)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A signal that calls a fetch off after `ms` (AbortSignal.timeout, where there is none: Safari 15). */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new TookTooLong("fetch")), ms);
  return controller.signal;
}

/** A question to the server (an address, a list): small, so answered soon or not at all. */
export const ASK_MS = 30_000;
/** A file fetched or sent: given long, for a large one on a slow network. */
export const FILE_MS = 5 * 60_000;
