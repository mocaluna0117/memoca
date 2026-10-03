import { uuidv7 } from "uuidv7";
import { getMeta, setMeta } from "./index";

export const META = {
  deviceId: "deviceId",
  cursor: "syncCursor",
  userKey: "userKey",
  clockOffset: "clockOffset",
  lastSyncAt: "lastSyncAt",
  /**
   * Pulled everything again once since pinned notes got places of their own:
   * a version from before kept no place for one changed meanwhile, which a
   * pull from where it left off would not bring again.
   */
  pinPlacesPulled: "pinPlacesPulled",
  lastHlc: "lastHlc",
  /** Last known account snapshot, so the app renders before Convex answers. */
  profile: "profile",
  /** Whether the person has opted into reading search and its 17 MB dictionary. */
  yomi: "yomiEnabled",
  /** The vault record (wrapped keys only), so the vault opens offline. */
  vaultRecord: "vaultRecord",
  /** Passkeys registered or used on this device, offered first on unlock. */
  passkeyLocal: "passkeyLocal",
  /** When "use Face ID / Touch ID here too?" was last declined on this device. */
  passkeyOfferAt: "passkeyOfferAt",
  /** When this device last asked for a new recovery key, to ask at most daily. */
  recoveryNudgeAt: "recoveryNudgeAt",
  /** What the last check found that this vault's key cannot open. */
  vaultHealth: "vaultHealth",
  /** Locked notes this device has sealed again for the server, by key epoch (reconcile.ts). */
  resealed: "resealed",
  /** A folder unlock this device has not finished, to resume on next open. */
  unlockJob: "unlockJob",
  /** Copies of other notes' files the server refused, and what they copied. */
  refusedCopies: "refusedCopies",
  /** What was being written in the quick note, until it is saved. */
  quickDraft: "quickDraft",
  /** Images written again as WebP whose replacement the server has yet to hear of. */
  replacedToTell: "replacedToTell",
  /** Images that, written again as WebP, came to no less (or are animated): not offered again. */
  convertKept: "convertKept",
  /**
   * Notes made here for Inbox before this device had it (a new account's
   * first, say): kept at the top level meanwhile, filed once it arrives.
   */
  awaitingInbox: "awaitingInbox",
} as const;

/**
 * A stable id for this browser profile. It breaks ties in last-writer-wins and
 * lets the server tell this device's own echoes from a peer's changes.
 */
export async function deviceId(): Promise<string> {
  const existing = await getMeta<string | null>(META.deviceId, null);
  if (existing) return existing;
  const fresh = uuidv7();
  await setMeta(META.deviceId, fresh);
  return fresh;
}
