import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
  unsent: vi.fn(async () => ({ changes: 0, files: 0, quickNotes: 1 })),
}));
vi.mock("@/lib/auth/client", () => ({ signOut: h.signOut }));
vi.mock("@/lib/db", () => ({ resetLocalData: h.reset }));
vi.mock("@/lib/sync/unsent", () => ({
  unsentOnDevice: h.unsent,
  anyUnsent: (kept: { changes: number; files: number; quickNotes: number }) =>
    kept.changes + kept.files + kept.quickNotes > 0,
}));
vi.mock("@/components/auth/unsent-warning", () => ({ UnsentText: () => null }));

import { SignOut } from "@/components/desktop/sign-out";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const replace = vi.fn();
const letGo = vi.fn(async () => undefined);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("location", { ...window.location, replace });
  window.memocaShell = { signOut: letGo, platform: "macos" } as unknown as Window["memocaShell"];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.memocaShell;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((each) => each.textContent === name)!;

test("「ログアウトしない」 goes back to the quick note, and nothing of the account is let go", async () => {
  await act(async () => root.render(<SignOut />));
  await settle();
  await act(async () => button("ログアウトしない").click());
  // Before: /app, which this window does not show (the browser opened it), and
  // the app had let go of its own window and the reminders already.
  expect(replace).toHaveBeenCalledWith("/quick?window=1");
  expect(letGo).not.toHaveBeenCalled();
  expect(h.signOut).not.toHaveBeenCalled();
});

test("signing out after all: the app lets go of what is the account's, then the session goes", async () => {
  await act(async () => root.render(<SignOut />));
  await settle();
  await act(async () => button("消えてもよいのでログアウト").click());
  await settle();
  expect(letGo).toHaveBeenCalledTimes(1);
  expect(h.reset).toHaveBeenCalled();
  expect(h.signOut).toHaveBeenCalled();
  expect(replace).toHaveBeenCalledWith("/sign-in");
});
