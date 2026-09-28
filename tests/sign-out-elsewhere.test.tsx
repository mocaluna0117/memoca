import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ revoke: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authClient: { revokeOtherSessions: h.revoke } }));

import { SignOutElsewhere } from "@/components/settings/sign-out-elsewhere";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  h.revoke.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<SignOutElsewhere />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const press = () => act(async () => host.querySelector("button")!.click());

describe("signing out every other device", () => {
  test("ends the others' sign-ins, the desktop app's among them, and says so", async () => {
    expect(host.textContent).toContain(
      "デスクトップ版や、ほかのブラウザ・スマホのログインを終わらせます",
    );
    h.revoke.mockResolvedValue({ data: { status: true }, error: null });
    await press();
    expect(h.revoke).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("ほかの端末をログアウトしました。");
  });

  test("says so when it could not", async () => {
    h.revoke.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    await press();
    expect(host.textContent).toContain("ログアウトできませんでした");
    h.revoke.mockRejectedValueOnce(new TypeError("offline"));
    await press();
    expect(host.textContent).toContain("ログアウトできませんでした");
  });
});
