import "fake-indexeddb/auto";
import { act, memo } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/** What the server says of the account: changed by the test as a push would. */
const h = vi.hoisted(() => ({
  remote: {
    userKey: "u1",
    email: "u1@example.com",
    name: "U",
    image: null,
    role: "user",
    quotaBytes: 1000,
    usedBytes: 0,
    reservedBytes: 0,
    settings: { theme: "system", trashRetentionDays: 30, autoLockMinutes: 5, prefetchBodies: true },
    inboxFolderId: "inbox",
    hasVault: false,
    limits: { maxImageBytes: 500, maxVideoBytes: 800 },
    createdAt: 0,
  } as Record<string, unknown>,
}));

// One client for the app's whole life, as the real one is: a new one each
// draw would make the context's value anew (submitInvite is made from it).
const client = {};
vi.mock("convex/react", () => ({
  useConvex: () => client,
  useQuery: () => h.remote,
}));
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => ({ profile: null, owner: "u1" }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("@/lib/sync/engine", () => ({
  SyncEngine: class {
    subscribe() {
      return () => {};
    }
    start() {
      return Promise.resolve(this);
    }
    stop() {}
    prefetchBodies() {
      return Promise.resolve();
    }
  },
}));
vi.mock("@/lib/sync/docs", () => ({ flushAll: () => Promise.resolve() }));
vi.mock("@/lib/crypto/vault", () => ({
  vault: { lock: () => {}, setAutoLockMinutes: () => {} },
}));

import {
  SyncProvider,
  useAllowance,
  useStorageUsage,
  useSync,
} from "@/components/providers/sync-provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renders = { me: 0, usage: 0 };
let seen: { me: unknown; usage: unknown; allowance: () => unknown } = {
  me: null,
  usage: null,
  allowance: () => null,
};

/** Follows the account: drawn again only when the context it reads changes. */
const MeProbe = memo(function MeProbe() {
  renders.me += 1;
  seen = { ...seen, me: useSync().me, allowance: useAllowance() };
  return null;
});
const UsageProbe = memo(function UsageProbe() {
  renders.usage += 1;
  seen = { ...seen, usage: useStorageUsage() };
  return null;
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  renders.me = 0;
  renders.usage = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const draw = () =>
  act(() =>
    root.render(
      <SyncProvider signedInAs="u1">
        <MeProbe />
        <UsageProbe />
      </SyncProvider>,
    ),
  );

test("the storage figures moving with each push draw the usage again, not every reader of the account", async () => {
  await draw();
  const meBefore = seen.me;
  const drawnMe = renders.me;
  const drawnUsage = renders.usage;
  for (const used of [10, 20, 30]) {
    h.remote = { ...h.remote, usedBytes: used };
    await draw();
  }
  expect(renders.usage - drawnUsage).toBe(3);
  expect(renders.me - drawnMe).toBe(0);
  expect(seen.me).toBe(meBefore);
  expect(seen.usage).toMatchObject({ usedBytes: 30, quotaBytes: 1000, limits: { maxImageBytes: 500 } });
  // The figures at the moment asked, for a file arriving, without a redraw.
  expect(seen.allowance()).toMatchObject({ usedBytes: 30 });
  expect(seen.me).not.toHaveProperty("usedBytes");
});

test("a change to the account itself (its name, say) reaches its readers", async () => {
  await draw();
  const drawnMe = renders.me;
  h.remote = { ...h.remote, name: "New" };
  await draw();
  expect(renders.me - drawnMe).toBe(1);
  expect(seen.me).toMatchObject({ name: "New" });
});
