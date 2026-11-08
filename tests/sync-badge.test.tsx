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
  } as SyncStatus,
  /** Edits in the outbox, as the badge counts them. */
  queued: 0,
}));
vi.mock("@/components/providers/sync-provider", () => ({
  useSyncStatus: () => h.status,
  useSync: () => ({ engine: () => null }),
}));
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
