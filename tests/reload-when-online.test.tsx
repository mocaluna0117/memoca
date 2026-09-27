import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ReloadWhenOnline } from "@/components/shell/reload-when-online";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test("the offline page offers to reload once it has started, and listens for the network then", async () => {
  const host = document.createElement("div");
  host.innerHTML = renderToString(<ReloadWhenOnline />);
  document.body.append(host);
  const button = () => host.querySelector("button")!;
  // As the page arrives, before its script runs: a press would do nothing.
  expect(button().disabled).toBe(true);

  const listen = vi.spyOn(window, "addEventListener");
  const root = await act(async () => hydrateRoot(host, <ReloadWhenOnline />));
  expect(button().disabled).toBe(false);
  expect(listen).toHaveBeenCalledWith("online", expect.any(Function));
  act(() => root.unmount());
});
