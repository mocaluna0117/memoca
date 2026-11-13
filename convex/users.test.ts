import { convexTest } from "convex-test";
import { register as registerAuth } from "@convex-dev/better-auth/test";
import { describe, expect, test, vi } from "vitest";
import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// getUser only accepts tokens minted by this deployment (see sync.test.ts).
process.env.CONVEX_SITE_URL = "https://convex.test";

function setup() {
  return convexTest(schema, modules);
}

async function signedIn(t: ReturnType<typeof setup>, authId = "authuser_a") {
  await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId,
      email: `${authId}@example.com`,
      role: "user",
      quotaBytes: 10_000_000,
      usedBytes: 0,
      reservedBytes: 0,
      settings: { theme: "system", trashRetentionDays: 30, autoLockMinutes: 5, prefetchBodies: true },
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject: authId });
}

describe("the welcome, shown once to each account", () => {
  test("not yet seen, then seen once marked, by that account alone", async () => {
    const t = setup();
    const me = await signedIn(t);
    const other = await signedIn(t, "authuser_b");
    expect((await me.query(api.users.me, {}))?.welcomed).toBe(false);

    await me.mutation(api.users.markWelcomed, {});
    expect((await me.query(api.users.me, {}))?.welcomed).toBe(true);
    expect((await other.query(api.users.me, {}))?.welcomed).toBe(false);

    // Marked again (another device of the account): when it was first seen stays.
    const first = await t.run(async (ctx) => (await ctx.db.query("users").first())?.welcomedAt);
    await me.mutation(api.users.markWelcomed, {});
    expect(await t.run(async (ctx) => (await ctx.db.query("users").first())?.welcomedAt)).toBe(first);
  });

  test("no one signed in cannot mark it", async () => {
    const t = setup();
    await expect(t.mutation(api.users.markWelcomed, {})).rejects.toThrow();
  });
});

describe("the app's look, kept for the account", () => {
  test("none chosen, none said (the first); chosen, kept with the other settings as they were", async () => {
    const t = setup();
    const me = await signedIn(t);
    expect((await me.query(api.users.me, {}))?.settings.style).toBeUndefined();

    await me.mutation(api.users.updateSettings, { style: "wafu" });
    expect((await me.query(api.users.me, {}))?.settings.style).toBe("wafu");
    await me.mutation(api.users.updateSettings, { style: "cute" });
    const settings = (await me.query(api.users.me, {}))?.settings;
    expect(settings?.style).toBe("cute");
    expect(settings?.trashRetentionDays).toBe(30);

    // Another setting changed: the look stays.
    await me.mutation(api.users.updateSettings, { trashRetentionDays: 7 });
    expect((await me.query(api.users.me, {}))?.settings.style).toBe("cute");
  });

  test("a look there is not, turned away", async () => {
    const t = setup();
    const me = await signedIn(t);
    await expect(
      me.mutation(api.users.updateSettings, { style: "neon" as unknown as "cute" }),
    ).rejects.toThrow();
  });
});

describe("deleting the account", () => {
  /** An account as signing in with Google leaves it: its sign-in rows, and the app's row by them. */
  async function withSignIn(t: ReturnType<typeof setup>) {
    const authId = await t.run(async (ctx) => {
      const now = Date.now();
      const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "user", data: { name: "A", email: "a@example.com", emailVerified: true, createdAt: now, updatedAt: now } },
      })) as { _id: string };
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "account", data: { accountId: "google-1", providerId: "google", userId: user._id, createdAt: now, updatedAt: now } },
      });
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "session", data: { token: "t1", userId: user._id, expiresAt: now + 3_600_000, createdAt: now, updatedAt: now } },
      });
      await ctx.db.insert("appConfig", { key: "global", userCount: 5, maxUsers: 50, signupOpen: true, defaultQuotaBytes: 1, maxImageBytes: 1, maxVideoBytes: 1 });
      return user._id;
    });
    return { authId, as: await signedIn(t, authId) };
  }

  const signInRows = (t: ReturnType<typeof setup>, authId: string) =>
    t.run(async (ctx) => {
      const count = async (model: "user" | "account" | "session", field: string) =>
        ((await ctx.runQuery(components.betterAuth.adapter.findMany, {
          model,
          where: [{ field, value: authId }],
          paginationOpts: { numItems: 10, cursor: null },
        })) as { page: unknown[] }).page.length;
      return { user: await count("user", "_id"), account: await count("account", "userId"), session: await count("session", "userId") };
    });

  test("takes the sign-in with it: no account, no sessions left, not only the notes", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      registerAuth(t);
      const { authId, as } = await withSignIn(t);
      expect(await signInRows(t, authId)).toEqual({ user: 1, account: 1, session: 1 });

      await as.mutation(api.users.deleteAccount, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // Before: the sign-in was left (its name, address, picture, Google's
      // tokens, and every other device's session), though the app said all
      // was deleted. Signed in again with it, other devices kept waiting on
      // an account that was gone.
      expect(await signInRows(t, authId)).toEqual({ user: 0, account: 0, session: 0 });
      expect(await t.run(async (ctx) => ctx.db.query("users").collect())).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("asked twice (two devices, a double press), counts the account out once", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      registerAuth(t);
      const { as } = await withSignIn(t);
      await as.mutation(api.users.deleteAccount, {});
      await as.mutation(api.users.deleteAccount, {}).catch(() => undefined);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const config = await t.run(async (ctx) => ctx.db.query("appConfig").first());
      expect(config!.userCount).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
