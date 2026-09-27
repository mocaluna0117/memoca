import { afterEach, describe, expect, test, vi } from "vitest";
import { openLinkApart } from "@/lib/open-link";

let host: HTMLDivElement;

/** A click on a link as BlockNote renders one, and the window it happens in. */
function clickOn(href: string, inside = "") {
  host = document.createElement("div");
  host.innerHTML = `<a data-inline-content-type="link" href="${href}"><span>${inside || "リンク"}</span></a>`;
  document.body.append(host);
  const here = { location: { href: "https://memoca.test/app" }, open: vi.fn() };
  const event = new MouseEvent("click", { bubbles: true });
  Object.defineProperty(event, "target", { value: host.querySelector("span") });
  return { handled: openLinkApart(event, here as unknown as Window), open: here.open };
}

afterEach(() => host?.remove());

describe("a link clicked in a note", () => {
  test("opens in a window of its own, which has no hold on the app's", () => {
    const { handled, open } = clickOn("https://example.com/a");
    expect(handled).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer");
  });

  test("mail and calls open too", () => {
    expect(clickOn("mailto:a@example.com").open).toHaveBeenCalledOnce();
    expect(clickOn("tel:0120000000").open).toHaveBeenCalledOnce();
  });

  test("a link that would run a script, or is not one at all, opens nothing", () => {
    const script = clickOn("javascript:alert(1)");
    expect(script.handled).toBe(true);
    expect(script.open).not.toHaveBeenCalled();
    expect(clickOn("data:text/html,<script>1</script>").open).not.toHaveBeenCalled();
  });

  test("a click that is not on a link is left to the editor", () => {
    const here = { location: { href: "https://memoca.test/app" }, open: vi.fn() };
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: document.body });
    expect(openLinkApart(event, here as unknown as Window)).toBe(false);
    expect(here.open).not.toHaveBeenCalled();
  });
});
