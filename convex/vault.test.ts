import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * convex-test needs to find every function module itself, which its bundler
 * does through import.meta.glob under Vite.
 */
const modules = import.meta.glob("./**/*.ts");

const AUTH_A = "authuser_a";
const AUTH_B = "authuser_b";

/** The issuer convex-test stamps on an identity when none is given. */
const TEST_ISSUER = "https://convex.test";

// getUser only accepts tokens minted by this deployment, identified by its own
// site URL. Set once for the whole file, as in sync.test.ts.
process.env.CONVEX_SITE_URL = TEST_ISSUER;

function setup() {
  return convexTest(schema, modules);
}

async function seedUser(t: ReturnType<typeof setup>, authId: string): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId,
      email: `${authId}@example.com`,
      role: "user",
      quotaBytes: 10_000_000,
      usedBytes: 0,
      reservedBytes: 0,
      settings: {
        theme: "system",
        trashRetentionDays: 30,
        autoLockMinutes: 5,
        prefetchBodies: true,
      },
      createdAt: Date.now(),
    }),
  );
}

const bytes = (...values: number[]) => new Uint8Array(values).buffer as ArrayBuffer;

/** A vault record as the client sends it; the contents are opaque here. */
const record = (marker: number) => ({
  argon: { m: 1024, t: 1, p: 1 },
  saltPw: bytes(marker, 1),
  pwWrap: { ct: bytes(marker, 2), iv: bytes(marker, 3) },
  recWrap: { hkdfSalt: bytes(marker, 4), ct: bytes(marker, 5), iv: bytes(marker, 6) },
});

describe("vault setup", () => {
  test("a second setup never replaces the vault that is already there", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    expect(await as.mutation(api.vault.setup, record(1))).toEqual({ status: "ok" });
    // Another device, or a stale screen, tries to create one again.
    expect(await as.mutation(api.vault.setup, record(2))).toEqual({ status: "already" });

    const status = await as.query(api.vault.status, {});
    expect(status).not.toBeNull();
    // Still the first vault's wrapping, unchanged.
    expect(new Uint8Array(status!.pwWrap.ct)).toEqual(new Uint8Array([1, 2]));
    expect(status!.version).toBe(1);
  });
});

describe("vault record", () => {
  test("says signed out, none, or exists, and never shows another person's vault", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    await seedUser(t, AUTH_B);
    const asA = t.withIdentity({ subject: AUTH_A });
    const asB = t.withIdentity({ subject: AUTH_B });

    expect(await t.query(api.vault.record, {})).toEqual({ state: "signedOut" });
    expect(await asA.query(api.vault.record, {})).toEqual({ state: "none" });

    await asA.mutation(api.vault.setup, { ...record(1), recoveryFormat: 2 });
    const mine = await asA.query(api.vault.record, {});
    expect(mine.state).toBe("exists");
    if (mine.state === "exists") {
      expect(mine.record.recoveryFormat).toBe(2);
      expect(mine.record.recoveryCheckedAt).toBeNull();
      expect(mine.record.version).toBe(1);
    }
    expect(await asB.query(api.vault.record, {})).toEqual({ state: "none" });
  });

  test("a vault made before the recovery key fix reports no format", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    const read = await as.query(api.vault.record, {});
    expect(read.state === "exists" && read.record.recoveryFormat).toBeNull();
  });
});

describe("vault rewrap", () => {
  test("a change based on an old version is refused and writes nothing", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));

    const stale = await as.mutation(api.vault.rewrap, {
      pwWrap: { ct: bytes(9, 9), iv: bytes(9, 9) },
      expectedVersion: 7,
    });
    expect(stale).toEqual({ status: "stale", version: 1 });
    const unchanged = await as.query(api.vault.status, {});
    expect(new Uint8Array(unchanged!.pwWrap.ct)).toEqual(new Uint8Array([1, 2]));
    expect(unchanged!.version).toBe(1);
  });

  test("a new recovery key is stored with its format and is not yet confirmed", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    await as.mutation(api.vault.markRecoveryChecked, {});

    const done = await as.mutation(api.vault.rewrap, {
      recWrap: record(3).recWrap,
      recoveryFormat: 2,
      expectedVersion: 1,
    });
    expect(done).toEqual({ status: "ok", version: 2 });
    const read = await as.query(api.vault.record, {});
    expect(read.state).toBe("exists");
    if (read.state === "exists") {
      expect(read.record.recoveryFormat).toBe(2);
      expect(read.record.recoveryCheckedAt).toBeNull();
      expect(new Uint8Array(read.record.recWrap!.ct)).toEqual(new Uint8Array([3, 5]));
    }
  });

  test("confirming the recovery key records when", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    expect(await as.mutation(api.vault.markRecoveryChecked, {})).toEqual({ status: "ok" });
    const read = await as.query(api.vault.record, {});
    expect(read.state === "exists" && typeof read.record.recoveryCheckedAt).toBe("number");
  });
});

describe("vault passkeys", () => {
  const passkey = (credentialId: string, label = "iPhone") => ({
    credentialId,
    prfInput: bytes(1),
    hkdfSalt: bytes(2),
    ct: bytes(3),
    iv: bytes(4),
    label,
  });

  test("registering the same passkey again replaces it rather than adding one", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    await as.mutation(api.vault.addPasskey, passkey("cred-1", "古い名前"));
    await as.mutation(api.vault.addPasskey, passkey("cred-1", "新しい名前"));
    const read = await as.query(api.vault.status, {});
    expect(read!.passkeys.map((p) => p.label)).toEqual(["新しい名前"]);
  });

  test("at most ten passkeys, and labels are kept short", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    for (let i = 0; i < 10; i += 1) {
      expect(await as.mutation(api.vault.addPasskey, passkey(`cred-${i}`))).toEqual({
        status: "ok",
      });
    }
    expect(await as.mutation(api.vault.addPasskey, passkey("cred-10"))).toEqual({
      status: "tooMany",
    });
    // Replacing an existing one is still allowed at the limit.
    await as.mutation(api.vault.addPasskey, passkey("cred-0", "あ".repeat(200)));
    const read = await as.query(api.vault.status, {});
    expect(read!.passkeys).toHaveLength(10);
    expect(read!.passkeys.find((p) => p.credentialId === "cred-0")!.label).toHaveLength(64);
  });

  test("removing a passkey leaves the password wrapping alone", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    await as.mutation(api.vault.addPasskey, passkey("cred-1"));
    await as.mutation(api.vault.removePasskey, { credentialId: "cred-1" });
    const read = await as.query(api.vault.status, {});
    expect(read!.passkeys).toHaveLength(0);
    expect(new Uint8Array(read!.pwWrap.ct)).toEqual(new Uint8Array([1, 2]));
  });
});
