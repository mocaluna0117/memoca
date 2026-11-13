import type { ConvexReactClient } from "convex/react";
import { afterEach, expect, test, vi } from "vitest";
import { turnOff } from "@/lib/notify/push";

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

test("with no network, turning this device's reminders off does not wait on the server for good: its subscription is dropped all the same", async () => {
  // A mutation sent while the connection is down neither answers nor fails:
  // it waits for the network. 「ログアウト」 waited with it, on a device
  // with reminders on, and nothing happened until the network came back.
  const unsubscribe = vi.fn(async () => true);
  const reg = { pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/e1", unsubscribe }) } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => reg, ready: Promise.resolve(reg) },
  });
  const mutation = vi.fn(() => new Promise(() => {}));
  vi.useFakeTimers();
  let done = false;
  const turning = turnOff({ mutation } as unknown as ConvexReactClient).then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  await turning;
  expect(done).toBe(true);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
