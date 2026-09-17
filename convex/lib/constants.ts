/** Defaults for a fresh deployment; all of these are editable from /app/admin. */
export const DEFAULTS = {
  signupOpen: true,
  maxUsers: 50,
  /** 100 MB per person. */
  defaultQuotaBytes: 100 * 1024 * 1024,
  /** Images are compressed in the browser before they get here. */
  maxImageBytes: 5 * 1024 * 1024,
  maxVideoBytes: 30 * 1024 * 1024,
  trashRetentionDays: 30,
  autoLockMinutes: 5,
} as const;

/** A stamp further ahead than this is a broken clock, not a real edit. */
export const MAX_CLOCK_SKEW_MS = 60_000;

/** Rows per table per `sync.pull` page. */
export const PULL_PAGE_LIMIT = 300;
/** Stop filling a pull response once the Yjs payloads reach this. */
export const PULL_BYTE_BUDGET = 700_000;
/** Reject a push larger than this; the client already splits at 1 MiB. */
export const PUSH_BYTE_BUDGET = 4 * 1024 * 1024;

/** Compaction thresholds: fold updates into a snapshot once either is crossed. */
export const COMPACT_UPDATE_COUNT = 64;
export const COMPACT_UPDATE_BYTES = 256 * 1024;

/** Snapshots above this go to file storage instead of inline bytes (1 MiB doc cap). */
export const SNAPSHOT_INLINE_LIMIT = 900_000;

/** An upload reservation this old is assumed abandoned. */
export const RESERVATION_TTL_MS = 60 * 60 * 1000;
/** Grace period before an attachment no block references is deleted. */
export const UNREFERENCED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Purged rows stay as tombstones this long so lagging devices still see them. */
export const TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;

/** How many devices to remember in `syncHeads.lastPushByDevice`. */
export const MAX_TRACKED_DEVICES = 10;

/** Guards against a pathological or malicious folder chain. */
export const MAX_FOLDER_DEPTH = 64;

export const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  /** Locked attachments are uploaded as opaque ciphertext. */
  "application/octet-stream",
] as const;
