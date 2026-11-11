import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const HOUR = 60 * 60 * 1000;

// getUser only accepts tokens minted by this deployment (see sync.test.ts).
process.env.CONVEX_SITE_URL = "https://convex.test";

function setup() {
  return convexTest(schema, modules);
}

async function signedIn(t: ReturnType<typeof setup>, authId = "authuser_a") {
  const userId = await t.run(async (ctx) =>
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
  return { as: t.withIdentity({ subject: authId }), userId };
}

const reminder = (key: string, at: number, title = "牛乳を買う") => ({ key, at, title, body: "期日 今日 18:00" });

const device = (n: number) => ({
  endpoint: `https://push.example.com/device-${n}`,
  p256dh: `p256dh-${n}`,
  auth: `auth-${n}`,
});

describe("the Todo's reminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("replaced whole: one kept as it was keeps its schedule, one changed is sent at its new time, one gone is not sent", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const now = Date.now();
    await as.mutation(api.reminders.replace, {
      reminders: [reminder("a:morning", now + HOUR), reminder("b:morning", now + 2 * HOUR), reminder("c:eve", now + 3 * HOUR)],
    });
    const before = await t.run((ctx) => ctx.db.query("reminders").collect());
    const keptId = before.find((row) => row.key === "a:morning")!.scheduledId;

    await as.mutation(api.reminders.replace, {
      reminders: [reminder("a:morning", now + HOUR), reminder("b:morning", now + 5 * HOUR), reminder("d:atTime", now + 4 * HOUR)],
    });
    const rows = await t.run((ctx) => ctx.db.query("reminders").collect());
    expect(rows.map((row) => [row.key, row.at - now]).sort()).toEqual(
      [
        ["a:morning", HOUR],
        ["b:morning", 5 * HOUR],
        ["d:atTime", 4 * HOUR],
      ].sort(),
    );
    expect(rows.find((row) => row.key === "a:morning")!.scheduledId).toBe(keptId);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const pending = scheduled.filter((job) => job.state.kind === "pending");
    // One for each reminder to come: the gone one's and the changed one's old schedule cancelled.
    expect(pending).toHaveLength(3);
    expect(pending.map((job) => job.scheduledTime - now).sort((a, b) => a - b)).toEqual([HOUR, 4 * HOUR, 5 * HOUR]);
  });

  test("past ones, and ones too far ahead, are not kept; too many, or too long, are turned down", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const now = Date.now();
    await as.mutation(api.reminders.replace, {
      reminders: [reminder("past", now - 1), reminder("far", now + 3 * 365 * 24 * HOUR), reminder("soon", now + HOUR)],
    });
    expect((await as.query(api.reminders.list, {})).map((row) => row.key)).toEqual(["soon"]);

    const many = Array.from({ length: 501 }, (_, i) => reminder(`k${i}`, now + HOUR));
    expect(await as.mutation(api.reminders.replace, { reminders: many })).toEqual({ status: "rejected", reason: "tooMany" });
    expect(
      await as.mutation(api.reminders.replace, { reminders: [reminder("long", now + HOUR, "あ".repeat(201))] }),
    ).toEqual({ status: "rejected", reason: "invalid" });
    // Turned down: what was kept stays.
    expect((await as.query(api.reminders.list, {})).map((row) => row.key)).toEqual(["soon"]);
  });

  test("its time come, it is sent to every device of the account and gone; another account's devices are not sent it", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const other = await signedIn(t, "authuser_b");
    await as.mutation(api.pushSubscriptions.subscribe, device(1));
    await as.mutation(api.pushSubscriptions.subscribe, device(2));
    await other.as.mutation(api.pushSubscriptions.subscribe, device(3));
    await as.mutation(api.reminders.replace, { reminders: [reminder("a:hourBefore", Date.now() + HOUR)] });

    await vi.advanceTimersByTimeAsync(HOUR + 1000);
    await t.finishInProgressScheduledFunctions();
    expect(await t.run((ctx) => ctx.db.query("reminders").collect())).toEqual([]);
    const sends = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (job) => job.name.includes("push"),
    );
    expect(sends).toHaveLength(1);
    const args = sends[0].args[0] as { devices: { endpoint: string }[]; title: string; tag: string };
    expect(args.devices.map((each) => each.endpoint).sort()).toEqual([device(1).endpoint, device(2).endpoint]);
    expect(args.title).toBe("牛乳を買う");
    expect(args.tag).toBe("a:hourBefore");
  });

  test("one moved later meanwhile is not sent at the old time", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const reminderId = await t.run((ctx) =>
      ctx.db.insert("reminders", { userId, key: "a:eve", at: Date.now() + 5 * HOUR, title: "t", body: "b" }),
    );
    await t.mutation(internal.reminders.fire, { reminderId });
    expect(await t.run((ctx) => ctx.db.get(reminderId))).not.toBeNull();
  });
});

describe("the devices reminders are sent to", () => {
  test("subscribed again as the app opens: the same row; a device another account had is this one's now", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const other = await signedIn(t, "authuser_b");
    await other.as.mutation(api.pushSubscriptions.subscribe, device(1));
    await as.mutation(api.pushSubscriptions.subscribe, device(1));
    await as.mutation(api.pushSubscriptions.subscribe, device(1));
    const rows = await t.run((ctx) => ctx.db.query("pushSubscriptions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);

    // Not https: turned down.
    expect(
      await as.mutation(api.pushSubscriptions.subscribe, { ...device(2), endpoint: "http://push.example.com/x" }),
    ).toEqual({ status: "rejected", reason: "invalid" });

    // Turned off: gone; another account's is not taken out by it.
    await other.as.mutation(api.pushSubscriptions.unsubscribe, { endpoint: device(1).endpoint });
    expect(await t.run((ctx) => ctx.db.query("pushSubscriptions").collect())).toHaveLength(1);
    await as.mutation(api.pushSubscriptions.unsubscribe, { endpoint: device(1).endpoint });
    expect(await t.run((ctx) => ctx.db.query("pushSubscriptions").collect())).toHaveLength(0);
  });

  test("the public key is the deployment's, and none where none is set", async () => {
    const t = setup();
    delete process.env.VAPID_PUBLIC_KEY;
    expect(await t.query(api.pushSubscriptions.publicKey, {})).toBeNull();
    // Set with nothing piped in: none either.
    process.env.VAPID_PUBLIC_KEY = "";
    expect(await t.query(api.pushSubscriptions.publicKey, {})).toBeNull();
    process.env.VAPID_PUBLIC_KEY = "BPublic";
    expect(await t.query(api.pushSubscriptions.publicKey, {})).toBe("BPublic");
    delete process.env.VAPID_PUBLIC_KEY;
  });

  test("an account deleted takes its reminders and devices with it", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.pushSubscriptions.subscribe, device(1));
    await as.mutation(api.reminders.replace, { reminders: [reminder("a:morning", Date.now() + HOUR)] });
    await t.mutation(internal.users.purgeAccount, { userId });
    expect(await t.run((ctx) => ctx.db.query("reminders").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("pushSubscriptions").collect())).toEqual([]);
    const pending = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (job) => job.state.kind === "pending",
    );
    expect(pending).toEqual([]);
    vi.useRealTimers();
  });
});
