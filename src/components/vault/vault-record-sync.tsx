"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import { loadLocalPasskeys, loadPlatformSupport } from "@/lib/vault/local-passkeys";
import { acceptServerRecord, hydrateVaultRecord } from "@/lib/vault/record";

/**
 * Keeps the device's copy of the vault record in step with the server.
 *
 * Subscribed for as long as the app is open, rather than only while the
 * unlock prompt is showing, so the prompt never has to wait on the network
 * and can open the vault offline.
 */
export function VaultRecordSync() {
  const { me } = useSync();
  const userKey = me?.userKey ?? null;
  const remote = useQuery(api.vault.record, userKey ? {} : "skip");

  useEffect(() => {
    if (userKey) void hydrateVaultRecord(userKey);
  }, [userKey]);

  // Read ahead of any unlock, so the passkey sheet can start inside the tap.
  useEffect(() => {
    void loadLocalPasskeys();
    loadPlatformSupport();
  }, []);

  useEffect(() => {
    if (userKey && remote) void acceptServerRecord(userKey, remote);
  }, [userKey, remote]);

  return null;
}
