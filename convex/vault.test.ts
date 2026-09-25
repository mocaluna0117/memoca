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
