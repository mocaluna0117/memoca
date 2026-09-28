import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  google: vi.fn(),
  session: null as null | { user: { email: string }; session: { createdAt: Date } },
}));
vi.mock("@/lib/auth/client", () => ({
  authClient: { $fetch: h.fetch, useSession: () => ({ data: h.session }) },
  signInWithGoogle: h.google,
}));

import { Handoff } from "@/components/desktop/handoff";
import { desktopHandoff } from "@/lib/auth/handoff";
import { forCallback } from "@/lib/auth/next";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATE = "s".repeat(40) + "_-7";
const CHALLENGE = "c".repeat(40) + "-_0";
const CHECK = "1A2B-3C4D";
const CODE = "T".repeat(32);
const MINUTE = 60 * 1000;

let root: Root;
let host: HTMLDivElement;
let assigned: string[];

/** Signed in `ago` ms since, as the browser's session says. */
const signedIn = (ago: number) => ({
  user: { email: "someone@example.com" },
  session: { createdAt: new Date(Date.now() - ago) },
});

const show = () =>
  act(async () => root.render(<Handoff state={STATE} challenge={CHALLENGE} check={CHECK} />));

beforeEach(async () => {
  h.fetch.mockReset();
  h.google.mockReset().mockResolvedValue(undefined);
  h.session = signedIn(MINUTE);
  // Where the page would go by itself, if it did.
  assigned = [];
  vi.stubGlobal("location", {
    ...window.location,
    assign: (url: string) => assigned.push(url),
    replace: (url: string) => assigned.push(url),
    set href(url: string) {
      assigned.push(url);
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await show();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find((found) => found.textContent === name);
const press = (name: string) => act(async () => button(name)!.click());

describe("handing over to the desktop shell", () => {
  test("says which account, what the shell may do with it, and the letters the shell shows", () => {
    expect(host.textContent).toContain("someone@example.com のアカウント");
    expect(host.textContent).toContain("このアカウントのメモを読み書きできるようになります");
    expect(host.textContent).toContain(CHECK);
    expect(host.textContent).toContain("文字が違うときは、続けずにこのページを閉じてください");
  });

  test("a code is made only at the press of the button, for the shell's challenge", async () => {
    h.fetch.mockResolvedValue({ data: { code: CODE }, error: null });
    expect(h.fetch).not.toHaveBeenCalled();

    await press("デスクトップ版にログインする");
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.fetch).toHaveBeenCalledWith("/desktop/code", {
      method: "POST",
      body: { challenge: CHALLENGE },
    });
  });

  test("the way back to the shell is a link to follow, never followed by the page itself", async () => {
    h.fetch.mockResolvedValue({ data: { code: CODE }, error: null });
    await press("デスクトップ版にログインする");
    const link = host.querySelector("a")!;
    expect(link.textContent).toBe("デスクトップ版の Memoca を開く");
    const back = new URL(link.href);
    expect(back.protocol).toBe("memoca:");
    expect(back.searchParams.get("code")).toBe(CODE);
    expect(back.searchParams.get("state")).toBe(STATE);
    expect(assigned).toEqual([]);
  });

  test("the code is shown only when asked, with what not to do with it", async () => {
    h.fetch.mockResolvedValue({ data: { code: CODE }, error: null });
    await press("デスクトップ版にログインする");
    expect(host.querySelector("code")).toBeNull();
    expect(host.textContent).not.toContain(CODE);

    await press("開かないときは、コードを表示");
    expect(host.querySelector("code")?.textContent).toBe(CODE);
    expect(host.textContent).toContain("「コードを貼り付け」の欄にだけ入れてください");
    expect(host.textContent).toContain("人に教えたりしないでください");
  });

  test("a browser signed in long ago asks Google again first, and comes back here", async () => {
    h.session = signedIn(10 * MINUTE);
    await show();
    await press("デスクトップ版にログインする");
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.google).toHaveBeenCalledWith(
      forCallback(desktopHandoff({ state: STATE, challenge: CHALLENGE })),
    );
  });

  test("pressed before the browser's session is known, leaves it to the server", async () => {
    h.session = null;
    await show();
    h.fetch.mockResolvedValue({ data: { code: CODE }, error: null });
    await press("デスクトップ版にログインする");
    expect(h.google).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  test("the server finding the sign-in not recent enough asks Google again too", async () => {
    h.fetch.mockResolvedValue({ data: null, error: { status: 403, code: "SIGN_IN_AGAIN" } });
    await press("デスクトップ版にログインする");
    expect(h.google).toHaveBeenCalledOnce();
    expect(host.querySelector("a")).toBeNull();
  });

  test("where the deployment has not turned it on, it says so, and offers nothing", async () => {
    h.fetch.mockResolvedValue({ data: null, error: { status: 404, message: "Not Found" } });
    await press("デスクトップ版にログインする");
    expect(host.textContent).toContain("デスクトップ版へのログインは、まだ使えません。");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("code")).toBeNull();
  });

  test("a code that could not be made can be asked for again", async () => {
    h.fetch.mockResolvedValueOnce({ data: null, error: { status: 500, message: "boom" } });
    await press("デスクトップ版にログインする");
    expect(host.textContent).toContain("ログインを続けられませんでした");
    expect(button("デスクトップ版にログインする")!.disabled).toBe(false);
    expect(host.querySelector("a")).toBeNull();
  });
});
