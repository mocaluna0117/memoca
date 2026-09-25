import { uuidv7 } from "uuidv7";
import { getMeta, setMeta } from "./index";

export const META = {
  deviceId: "deviceId",
  cursor: "syncCursor",
  userKey: "userKey",
  clockOffset: "clockOffset",
  lastSyncAt: "lastSyncAt",
  lastHlc: "lastHlc",
  /** Last known account snapshot, so the app renders before Convex answers. */
  profile: "profile",
  /** Whether the person has opted into reading search and its 17 MB dictionary. */
  yomi: "yomiEnabled",
  /** The vault record (wrapped keys only), so the vault opens offline. */
  vaultRecord: "vaultRecord",
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
