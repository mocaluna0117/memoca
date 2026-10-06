import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
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
