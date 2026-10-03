import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authClient: { $fetch: h.fetch } }));
vi.mock("next/link", () => ({ default: (props: object) => <a {...props} /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = "C".repeat(32);
const VERIFIER = "v".repeat(40) + "_-1";

let root: Root;
let host: HTMLDivElement;
let replace: ReturnType<typeof vi.fn>;
let take: ReturnType<typeof vi.fn>;

/**
 * Opens /desktop/complete in the shell's window, which hands it `given`
 * (sign_in.rs). The page asks once per load: a fresh module for each.
 */
async function open(given: unknown, twice = false) {
  vi.resetModules();
  const { Complete } = await import("@/components/desktop/complete");
  take = vi.fn(async () => given);
  window.memocaShell = {
    hide() {},
    openExternal() {},
    takeSignIn: take as () => Promise<{ code: string; verifier: string } | null>,
    platform: "macos",
  };
  replace = vi.fn();
  vi.stubGlobal("location", { ...window.location, replace });
  await act(async () => root.render(<Complete />));
  // As React's strict mode runs an effect twice.
  if (twice) await act(async () => root.render(<Complete key="again" />));
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  h.fetch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete window.memocaShell;
});

describe("taking the code in the shell's window", () => {
  test("takes what the shell hands over, once, and opens the quick note in its place", async () => {
    h.fetch.mockResolvedValue({ data: { signedIn: true }, error: null });
    await open({ code: CODE, verifier: VERIFIER }, true);
    expect(take).toHaveBeenCalledOnce();
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.fetch).toHaveBeenCalledWith("/desktop/exchange", {
      method: "POST",
      body: { code: CODE, verifier: VERIFIER },
    });
    expect(replace).toHaveBeenCalledWith("/quick?window=1");
  });

  test("in the shell's window for the whole app, opens the notes in its place", async () => {
    h.fetch.mockResolvedValue({ data: { signedIn: true }, error: null });
    vi.stubGlobal("location", { ...window.location, search: "?to=app" });
    await open({ code: CODE, verifier: VERIFIER });
    expect(replace).toHaveBeenCalledWith("/app");
  });

  test("goes nowhere else than the quick note or the notes", async () => {
    const { nextPage } = await import("@/components/desktop/complete");
    expect(nextPage("?to=app")).toBe("/app");
    expect(nextPage("")).toBe("/quick?window=1");
    expect(nextPage("?to=https://example.com")).toBe("/quick?window=1");
  });

  test("turned down, says so, and offers to sign in again", async () => {
    h.fetch.mockResolvedValue({ data: null, error: { status: 400, message: "Invalid code" } });
    await open({ code: CODE, verifier: VERIFIER });
    expect(host.textContent).toContain("ログインできませんでした");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/sign-in");
    expect(replace).not.toHaveBeenCalled();
  });

  test("handed nothing (opened by anything but the shell), asks for nothing", async () => {
    await open(null);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain("続けるログインがありません");
  });

  test("handed something of the wrong shape, asks for nothing", async () => {
    await open({ code: "short", verifier: VERIFIER });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain("続けるログインがありません");
  });
});
