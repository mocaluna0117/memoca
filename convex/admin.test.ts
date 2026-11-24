import { convexTest } from "convex-test";
import { register as registerAuth } from "@convex-dev/better-auth/test";
import { describe, expect, test, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
process.env.CONVEX_SITE_URL = "https://convex.test";

const MB = 1024 * 1024;

test("a new default quota reaches everyone still on the old one, and no one given their own", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const person = (authId: string, role: "user" | "admin", quotaBytes: number) =>
      t.run(async (ctx) =>
        ctx.db.insert("users", {
          authId,
          email: `${authId}@example.com`,
          role,
          quotaBytes,
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
    await person("admin", "admin", 100 * MB);
    await person("plain", "user", 100 * MB);
    await person("given", "user", 500 * MB);
    await t.run(async (ctx) =>
      ctx.db.insert("appConfig", {
        key: "global",
        signupOpen: true,
        maxUsers: 50,
        userCount: 3,
        defaultQuotaBytes: 100 * MB,
        maxImageBytes: 5 * MB,
        maxVideoBytes: 30 * MB,
      }),
    );

    const admin = t.withIdentity({ subject: "admin" });
    await admin.mutation(api.admin.setConfig, { maxUsers: 4, defaultQuotaBytes: 200 * MB });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const quotas = await t.run(async (ctx) =>
      Object.fromEntries(
        (await ctx.db.query("users").collect()).map((u) => [u.authId, u.quotaBytes / MB]),
      ),
    );
    expect(quotas).toEqual({ admin: 200, plain: 200, given: 500 });
    const overview = await admin.query(api.admin.overview, {});
    expect(overview.config.maxUsers).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

describe("from the admin screen", () => {
  type T = ReturnType<typeof convexTest>;
  const settings = { theme: "system" as const, trashRetentionDays: 30, autoLockMinutes: 5, prefetchBodies: true };

  /** An account as signing in with Google leaves it (its sign-in rows), and the app's row by them, with a note. */
  async function account(t: T, email: string, role: "user" | "admin" = "user") {
    return t.run(async (ctx) => {
      const now = Date.now();
      const auth = (await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "user", data: { name: email, email, emailVerified: true, createdAt: now, updatedAt: now } },
      })) as { _id: string };
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "session", data: { token: `t-${email}`, userId: auth._id, expiresAt: now + 3_600_000, createdAt: now, updatedAt: now } },
      });
      const userId = await ctx.db.insert("users", {
        authId: auth._id,
        email,
        role,
        quotaBytes: 100 * MB,
        usedBytes: 0,
        reservedBytes: 0,
        settings,
        createdAt: now,
      });
      await ctx.db.insert("folders", {
        userId,
        folderId: `inbox-${email}`,
        parentId: null,
        name: "Inbox",
        icon: "inbox",
        sortKey: "a",
        locked: false,
        system: "inbox",
        deletedAt: null,
        purged: false,
        ts: {
          name: { t: now, d: "d" },
          place: { t: now, d: "d" },
          trash: { t: 0, d: "d" },
          lock: { t: 0, d: "d" },
        },
        deviceId: "d",
        seq: 1,
      });
      return { userId, authId: auth._id };
    });
  }

  async function setupAdmin() {
    const t = convexTest(schema, modules);
    registerAuth(t);
    await t.run(async (ctx) =>
      ctx.db.insert("appConfig", {
        key: "global",
        signupOpen: true,
        maxUsers: 50,
        userCount: 3,
        defaultQuotaBytes: 100 * MB,
        maxImageBytes: 5 * MB,
        maxVideoBytes: 30 * MB,
      }),
    );
    const admin = await account(t, "admin@example.com", "admin");
    const person = await account(t, "person@example.com");
    const other = await account(t, "other@example.com");
    return { t, admin, person, other, asAdmin: t.withIdentity({ subject: admin.authId }) };
  }

  const sessionsOf = (t: T, authId: string) =>
    t.run(async (ctx) =>
      ((await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "session",
        where: [{ field: "userId", value: authId }],
        paginationOpts: { numItems: 10, cursor: null },
      })) as { page: unknown[] }).page.length,
    );

  test("someone taken out: signed out everywhere, their rows gone, counted out once, the others untouched", async () => {
    vi.useFakeTimers();
    try {
      const { t, person, other, asAdmin } = await setupAdmin();
      expect(await asAdmin.mutation(api.admin.removeUser, { userId: person.userId })).toEqual({ status: "scheduled" });
      // On its way out at once: shown so, and not taken out twice.
      const listed = (await asAdmin.query(api.admin.overview, {})).users.find((u) => u.id === person.userId);
      expect(listed?.removed).toBe(true);
      expect(await asAdmin.mutation(api.admin.removeUser, { userId: person.userId })).toEqual({ status: "gone" });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(await sessionsOf(t, person.authId)).toBe(0);
      expect(await sessionsOf(t, other.authId)).toBe(1);
      const left = await t.run(async (ctx) => ({
        users: (await ctx.db.query("users").collect()).map((u) => u.email).sort(),
        folders: (await ctx.db.query("folders").collect()).map((f) => f.folderId).sort(),
        count: (await ctx.db.query("appConfig").first())!.userCount,
      }));
      expect(left).toEqual({
        users: ["admin@example.com", "other@example.com"],
        folders: ["inbox-admin@example.com", "inbox-other@example.com"],
        count: 2,
      });
      // Gone for good: their device's token makes nothing again.
      await expect(
        t.withIdentity({ subject: person.authId }).mutation(api.users.ensure, { deviceId: "d", inboxFolderId: "x" }),
      ).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  test("never oneself, nor an admin, and only by an admin", async () => {
    const { t, admin, person, other, asAdmin } = await setupAdmin();
    expect(await asAdmin.mutation(api.admin.removeUser, { userId: admin.userId })).toEqual({ status: "self" });
    await t.run(async (ctx) => ctx.db.patch("users", other.userId, { role: "admin" }));
    expect(await asAdmin.mutation(api.admin.removeUser, { userId: other.userId })).toEqual({ status: "admin" });
    await expect(
      t.withIdentity({ subject: person.authId }).mutation(api.admin.removeUser, { userId: other.userId as Id<"users"> }),
    ).rejects.toThrow("管理者のみ");
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(3);
  });

  test("one person's storage, set alone; out of range, refused", async () => {
    const { t, person, asAdmin } = await setupAdmin();
    expect(await asAdmin.mutation(api.admin.setUserQuota, { userId: person.userId, quotaBytes: 1024 * MB })).toEqual({
      status: "ok",
    });
    const quotas = await t.run(async (ctx) =>
      Object.fromEntries((await ctx.db.query("users").collect()).map((u) => [u.email, u.quotaBytes / MB])),
    );
    expect(quotas).toEqual({ "admin@example.com": 100, "person@example.com": 1024, "other@example.com": 100 });
    await expect(asAdmin.mutation(api.admin.setUserQuota, { userId: person.userId, quotaBytes: -1 })).rejects.toThrow();
    await expect(
      asAdmin.mutation(api.admin.setUserQuota, { userId: person.userId, quotaBytes: 101 * 1024 * MB }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity({ subject: person.authId }).mutation(api.admin.setUserQuota, { userId: person.userId, quotaBytes: 1 }),
    ).rejects.toThrow("管理者のみ");
  });

  test("an invite good until the day chosen, for as many uses as asked; a day gone by, refused", async () => {
    const { asAdmin } = await setupAdmin();
    const until = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const code = await asAdmin.mutation(api.admin.createInvite, { uses: 3, expiresInDays: null, expiresAt: until });
    const invite = (await asAdmin.query(api.admin.overview, {})).invites.find((i) => i.code === code);
    expect(invite).toMatchObject({ usesLeft: 3, expiresAt: until });
    await expect(
      asAdmin.mutation(api.admin.createInvite, { uses: 1, expiresInDays: null, expiresAt: Date.now() - 1000 }),
    ).rejects.toThrow("いまより先");
    // With no date, for good, as before.
    const forGood = await asAdmin.mutation(api.admin.createInvite, { uses: 1, expiresInDays: null });
    expect((await asAdmin.query(api.admin.overview, {})).invites.find((i) => i.code === forGood)?.expiresAt).toBeNull();
  });
});
