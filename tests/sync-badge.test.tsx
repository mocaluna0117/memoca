import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SyncStatus } from "@/lib/sync/engine";

const h = vi.hoisted(() => ({
  status: {
    state: "idle",
    pending: 0,
    lastSyncAt: null,
    catchingUp: false,
    quotaFull: false,
    heldForVault: false,
    stuck: 0,
    uploadRefused: false,
    saveFailed: false,
    signInWait: false,
    uploadsWaiting: 0,
  } as SyncStatus,
  /** Edits in the outbox, as the badge counts them. */
  queued: 0,
  /** Told of a new status, as the provider's store tells those following it. */
  listeners: new Set<() => void>(),
}));
vi.mock("@/components/providers/sync-provider", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  };
  return {
    useSyncStatus: () => useSyncExternalStore(subscribe, () => h.status),
    useSyncStatusOf: <T,>(select: (status: SyncStatus) => T) =>
      useSyncExternalStore(subscribe, () => select(h.status)),
    useSync: () => ({ engine: () => null }),
  };
});
vi.mock("@/lib/hooks/data", () => ({ useOutboxCount: () => h.queued }));

import { SyncBadge } from "@/components/shell/sync-badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n/ja";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function badge(status: Partial<SyncStatus>, queued = 0) {
  h.status = { ...h.status, ...status };
  h.queued = queued;
  act(() => {
    for (const listener of h.listeners) listener();
  });
  act(() =>
    root.render(
      <TooltipProvider>
        <SyncBadge />
      </TooltipProvider>,
    ),
  );
  return host.querySelector('[role="status"]')!;
}

test("edits of a locked note waiting for the vault are said, without spinning", () => {
  const shown = badge({ heldForVault: true });
  expect(shown.getAttribute("aria-label")).toBe(t.sync.heldForVault);
  expect(shown.querySelector(".animate-spin")).toBeNull();
});

test("edits set aside as unsendable are said first; then a file refused; then a store that failed", () => {
  expect(badge({ stuck: 1, uploadRefused: true, saveFailed: true }).getAttribute("aria-label")).toBe(
    t.sync.stuck,
  );
  expect(badge({ stuck: 0, uploadRefused: true, saveFailed: true }).getAttribute("aria-label")).toBe(
    t.sync.uploadRefused,
  );
  expect(badge({ stuck: 0, uploadRefused: false, saveFailed: true }).getAttribute("aria-label")).toBe(
    t.sync.saveFailed,
  );
  expect(
    badge({ stuck: 0, uploadRefused: false, saveFailed: false, heldForVault: false }).getAttribute(
      "aria-label",
    ),
  ).toBe(t.sync.idle);
});

test("with nothing waiting, the badge says all is synced", () => {
  const shown = badge({ heldForVault: false });
  expect(shown.getAttribute("aria-label")).toBe(t.sync.idle);
});


test("edits waiting for the sign-in to come back are said, though some are queued, and not as an error", () => {
  const shown = badge({ signInWait: true }, 3);
  expect(shown.getAttribute("aria-label")).toBe(t.sync.signInWait);
  expect(shown.className).not.toContain("text-destructive");
  badge({ signInWait: false }, 0);
});

test("files waiting to be tried again are said, after anything wrong", () => {
  expect(badge({ uploadsWaiting: 2 }).getAttribute("aria-label")).toBe(t.sync.uploadsWaiting);
  expect(badge({ uploadsWaiting: 2, stuck: 1 }).getAttribute("aria-label")).toBe(t.sync.stuck);
  expect(badge({ uploadsWaiting: 0, stuck: 0 }).getAttribute("aria-label")).toBe(t.sync.idle);
});
