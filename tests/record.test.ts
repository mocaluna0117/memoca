import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareVault, unlockWithPassword, vault } from "@/lib/crypto/vault";
import { getMeta, resetLocalData } from "@/lib/db";
import { META } from "@/lib/db/meta";
import {
  acceptServerRecord,
  hydrateVaultRecord,
  useVaultRecord,
} from "@/lib/vault/record";
import { FAST_ARGON } from "./helpers/seed";

const PASSWORD = "パスワード";

async function serverAnswer() {
  const { record } = await prepareVault(PASSWORD, FAST_ARGON);
  return {
    state: "exists" as const,
    record: {
      ...record,
      hasRecovery: true,
      passkeys: [],
      version: 1,
      recoveryFormat: 2,
      recoveryCheckedAt: null,
    },
  };
}

function forget() {
  useVaultRecord.setState({ availability: "unknown", record: null, source: null, userKey: null });
}

beforeEach(async () => {
  await resetLocalData();
  forget();
});

afterEach(() => vault.lock());

describe("the vault record on the device", () => {
  test("opens the vault with no server, from what was kept on the device", async () => {
    await acceptServerRecord("user-a", await serverAnswer());

    // A later start with no network: only the device's copy is there.
    forget();
    await hydrateVaultRecord("user-a");
    const { availability, record, source } = useVaultRecord.getState();
    expect(availability).toBe("exists");
    expect(source).toBe("cache");
    await unlockWithPassword(record!, PASSWORD);
    expect(vault.isUnlocked).toBe(true);
  });

  test("never remembers 'no vault', so a new device cannot be told to create one", async () => {
    await acceptServerRecord("user-a", await serverAnswer());
    const storing = acceptServerRecord("user-a", { state: "none" });
    // The state changes at once, before the device's copy is removed.
    expect(useVaultRecord.getState().availability).toBe("none");
    await storing;
    expect(await getMeta(META.vaultRecord, null)).toBeNull();

    forget();
    await hydrateVaultRecord("user-a");
    expect(useVaultRecord.getState().availability).toBe("unknown");
  });

  test("ignores a copy that belongs to another account", async () => {
    await acceptServerRecord("user-a", await serverAnswer());
    forget();
    await hydrateVaultRecord("user-b");
    expect(useVaultRecord.getState()).toMatchObject({ availability: "unknown", record: null });
  });

  test("a slower read of the device's copy does not replace the server's answer", async () => {
    const answer = await serverAnswer();
    await acceptServerRecord("user-a", { state: "none" });
    await hydrateVaultRecord("user-a");
    expect(useVaultRecord.getState()).toMatchObject({ availability: "none", source: "server" });
    await acceptServerRecord("user-a", answer);
    await hydrateVaultRecord("user-a");
    expect(useVaultRecord.getState().source).toBe("server");
  });

  test("signed out changes nothing", async () => {
    await acceptServerRecord("user-a", await serverAnswer());
    await acceptServerRecord("user-a", { state: "signedOut" });
    expect(useVaultRecord.getState().availability).toBe("exists");
  });
});
