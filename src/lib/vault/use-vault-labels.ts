"use client";

import { unlockMethodName, withMethod } from "@/lib/crypto/platform";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { usePlatformPasskey } from "./local-passkeys";
import { useVaultRecord } from "./record";

/** What this device calls its passkey check: Face ID / Touch ID, and so on. */
export function useUnlockMethod(): string {
  return useClientValue(() => unlockMethodName(), "パスキー");
}

/** Whether opening the vault here can use a passkey rather than the password. */
export function usePasskeyUsable(): boolean {
  const platform = usePlatformPasskey();
  const passkeys = useVaultRecord((s) => s.record?.passkeys.length ?? 0);
  return platform && passkeys > 0;
}

/** The label for a button that opens the vault: 「Face ID / Touch ID で開く」 or 「金庫を開く」. */
export function useOpenVaultLabel(): string {
  const method = useUnlockMethod();
  return usePasskeyUsable() ? withMethod(method, "で開く") : "金庫を開く";
}
