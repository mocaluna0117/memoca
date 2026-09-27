import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ generate: vi.fn(), link: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authClient: { oneTimeToken: { generate: h.generate } } }));
vi.mock("@/lib/auth/handoff", async (original) => {
  const real = await original<typeof import("@/lib/auth/handoff")>();
  return {
    ...real,
    handoffLink: (token: string, state: string) => {
      h.link(token, state);
      // Somewhere jsdom can go without complaint; handoffLink itself is tested with the rest of handoff.ts.
      return "#handed-over";
    },
  };
});

import { Handoff } from "@/components/desktop/handoff";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATE = "s".repeat(40) + "_-7";
const TOKEN = "T".repeat(32);

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  h.generate.mockReset();
  h.link.mockReset();
  window.location.hash = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Handoff state={STATE} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const press = () => act(async () => host.querySelector("button")!.click());

describe("handing over to the desktop shell", () => {
  test("a token is made only at the press of the button, and goes to the shell with its state", async () => {
    h.generate.mockResolvedValue({ data: { token: TOKEN }, error: null });
    expect(h.generate).not.toHaveBeenCalled();

    await press();
    expect(h.generate).toHaveBeenCalledOnce();
    expect(h.link).toHaveBeenCalledWith(TOKEN, STATE);
    expect(window.location.hash).toBe("#handed-over");
    expect(host.querySelector("code")?.textContent).toBe(TOKEN);
  });

  test("where the deployment has not turned it on, it says so, and makes nothing", async () => {
    h.generate.mockResolvedValue({ data: null, error: { status: 404, message: "Not Found" } });
    await press();
    expect(host.textContent).toContain("デスクトップ版へのログインは、まだ使えません。");
    expect(h.link).not.toHaveBeenCalled();
    expect(host.querySelector("code")).toBeNull();
  });

  test("a token that could not be made can be asked for again", async () => {
    h.generate.mockResolvedValueOnce({ data: null, error: { status: 500, message: "boom" } });
    await press();
    expect(host.textContent).toContain("コードを作れませんでした");
    expect(host.querySelector("button")!.disabled).toBe(false);
  });
});
