/**
 * Whether an error is a part of the app failing to load: the page was
 * opened before a new version went out, and the part it asks for later is
 * gone from the server (or the network dropped while fetching it). Trying
 * again in place fetches the same missing part; loading the page again
 * brings the new version.
 */
export function isStaleChunk(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return /Loading (CSS )?chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    error.message,
  );
}
