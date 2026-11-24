import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const MB = 1024 * 1024;

const h = vi.hoisted(() => ({
  /** Each mutation the screen calls, by its name ("admin:createInvite"). */
  calls: [] as { name: string; args: unknown }[],
  results: {} as Record<string, unknown>,
  overview: null as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: () => h.overview,
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    h.calls.push({ name, args });
    return h.results[name] ?? { status: "ok" };
  },
}));
vi.mock("@/components/providers/sync-provider", () => ({
  useSync: () => ({ me: { email: "me@example.com" } }),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileHeader: () => null }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import AdminView, { endOfDay } from "@/components/views/admin-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const person = (id: string, email: string, extra: Record<string, unknown> = {}) => ({
  id,
  email,
  name: null,
  role: "user",
  quotaBytes: 200 * MB,
  usedBytes: 3 * MB,
  reservedBytes: 0,
  createdAt: Date.UTC(2026, 9, 1),
  removed: false,
  admin: false,
  ...extra,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  h.calls = [];
  h.results = {};
  h.overview = {
    config: {
      signupOpen: false,
      maxUsers: 5,
      userCount: 4,
      defaultQuotaBytes: 200 * MB,
      maxImageBytes: 5 * MB,
      maxVideoBytes: 30 * MB,
    },
    usedBytes: 9 * MB,
    users: [
      person("u-me", "me@example.com", { role: "admin", admin: true }),
      person("u-admin", "boss@example.com", { admin: true }),
      person("u-a", "a@example.com"),
      person("u-gone", "gone@example.com", { removed: true }),
    ],
    invites: [{ code: "OLDCODE1", usesLeft: 1, expiresAt: Date.now() - 1000, memo: "去年の", createdAt: 0 }],
  };
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AdminView />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

/** A field by its id, or by its aria-label. */
const byLabel = (label: string) =>
  (document.getElementById(label) as HTMLInputElement | null) ??
  [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.getAttribute("aria-label") === label)!;
const buttons = (text: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
/** Types into a field as React hears it. */
async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("invite codes", () => {
  test("issued for as many uses as typed, good until the end of the day chosen, with a note of who for", async () => {
    await type(byLabel("invite-uses"), "3");
    await type(byLabel("invite-until"), "2099-01-31");
    await type(byLabel("invite-memo"), "山田さん");
    await act(async () => buttons("発行")[0]!.click());
    expect(h.calls).toEqual([
      {
        name: "admin:createInvite",
        args: { uses: 3, expiresInDays: null, expiresAt: new Date(2099, 0, 31, 23, 59, 59, 999).getTime(), memo: "山田さん" },
      },
    ]);
  });

  test("for good, with no date; nothing issued for a count out of range", async () => {
    await type(byLabel("invite-uses"), "0");
    expect(buttons("発行")[0]!.disabled).toBe(true);
    await type(byLabel("invite-uses"), "1");
    const forGood = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes("期限なし"))!;
    await act(async () => forGood.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await act(async () => buttons("発行")[0]!.click());
    expect(h.calls.at(-1)).toEqual({ name: "admin:createInvite", args: { uses: 1, expiresInDays: null } });
  });

  test("one gone by is shown so", () => {
    expect(document.body.textContent).toContain("期限切れ");
  });

  test("a day written as a date field writes it ends at its last moment, on this device's calendar", () => {
    expect(endOfDay("2026-12-01")).toBe(new Date(2026, 11, 1, 23, 59, 59, 999).getTime());
    expect(endOfDay("")).toBeNull();
    expect(endOfDay("2026-13-99")).not.toBeNull(); // the field never gives one; Date rolls it over
  });
});

describe("people", () => {
  test("one person's storage set alone, in MB", async () => {
    await type(byLabel("a@example.com の容量 (MB)"), "1024");
    await act(async () => buttons("保存").at(-1)!.click());
    expect(h.calls).toEqual([{ name: "admin:setUserQuota", args: { userId: "u-a", quotaBytes: 1024 * MB } }]);
  });

  test("taken out after asking; never oneself or an admin, nor one already on the way out", async () => {
    // Only a@example.com has the button.
    expect(buttons("退会させる")).toHaveLength(1);
    expect(document.body.textContent).toContain("退会の処理中");
    h.results["admin:removeUser"] = { status: "scheduled" };
    await act(async () => buttons("退会させる")[0]!.click());
    expect(document.body.textContent).toContain("a@example.com を退会させますか？");
    expect(h.calls).toEqual([]);
    const confirm = buttons("退会させる").find((button) => button.closest('[role="alertdialog"]'))!;
    await act(async () => confirm.click());
    expect(h.calls).toEqual([{ name: "admin:removeUser", args: { userId: "u-a" } }]);
  });
});
