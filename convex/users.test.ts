import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
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
