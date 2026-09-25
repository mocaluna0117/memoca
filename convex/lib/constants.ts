const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Defaults for a fresh deployment; all of these are editable from /app/admin.
 *
 * The environment can raise the registration cap, which is how the end-to-end
 * suite creates a throwaway account per test without tripping the guard that
 * protects the free tier in production.
 */
export const DEFAULTS = {
  signupOpen: true,
  maxUsers: envNumber("MAX_USERS", 50),
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

/**
 * Passkeys one vault accepts. Each is one wrapping of the vault key, and the
 * list travels with every read of the vault record.
 */
export const MAX_PASSKEYS = 10;

/** Longest passkey label kept. Labels are generated, but arrive from clients. */
export const PASSKEY_LABEL_MAX = 64;

/**
 * Update rows one lock or unlock replaces. More than this has to be compacted
 * first, or rows past the limit would survive the swap in plaintext.
 */
export const REPLACE_BODY_LIMIT = 2000;

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
