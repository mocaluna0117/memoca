import { db } from "@/lib/db";
import type { ArgonParams } from "@/lib/crypto/primitives";
import type { Folder } from "@/lib/types";

export const zero = { t: 0, d: "test" };

/**
 * Argon2id settings for tests only. The real ones cost a second or more per
 * derivation, which adds up across a suite that opens vaults repeatedly.
 */
export const FAST_ARGON: ArgonParams = { m: 1024, t: 1, p: 1 };

/** The Inbox as it arrives from the server on first sign-in. */
export async function seedInbox(id = "inbox"): Promise<string> {
  const inbox: Folder = {
    folderId: id,
    parentId: null,
    name: "Inbox",
    icon: "inbox",
    sortKey: "a",
    locked: false,
    system: "inbox",
    deletedAt: null,
    purged: false,
    ts: { name: zero, place: zero, trash: zero, lock: zero },
    seq: 1,
  };
  await db().folders.put(inbox);
  return id;
}
