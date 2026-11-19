import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ height: 0 }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("@/lib/hooks/use-keyboard-inset", () => ({
  useKeyboard: () => ({ height: h.height, covered: h.height }),
}));

import { MobileNav } from "@/components/shell/mobile-nav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  h.height = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("the bottom bar is out of sight while the keyboard is up, as an app's own is under it", async () => {
  await act(() => root.render(<MobileNav />));
  const nav = () => host.querySelector<HTMLElement>("[data-mobile-nav]")!;
  expect(nav().hidden).toBe(false);

  h.height = 336;
  await act(() => root.render(<MobileNav />));
  expect(nav().hidden).toBe(true);

  h.height = 0;
  await act(() => root.render(<MobileNav />));
  expect(nav().hidden).toBe(false);
});
