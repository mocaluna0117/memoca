import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
// Off to Google's page: never comes back while this page is left.
vi.mock("@/lib/auth/client", () => ({ signInWithGoogle: () => new Promise(() => {}) }));

import { SignInCard } from "@/components/auth/sign-in-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("back from Google's page (shown again from the browser's cache): the button can be pressed again", async () => {
  await act(async () => root.render(<SignInCard next="/app" />));
  const button = host.querySelector("button")!;
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  await act(async () => {
    const shown = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(shown, "persisted", { value: true });
    window.dispatchEvent(shown);
  });
  expect(button.disabled).toBe(false);
});
