import { expect, type Page, test } from "@playwright/test";

/**
 * What the Google button asks the server to come back to, once the server
 * has taken it (better-auth turns away a way back it does not accept), and
 * stopped on the way to Google.
 */
async function askedToComeBackTo(page: Page): Promise<{ callbackURL: string }> {
  await page.route("https://accounts.google.com/**", (route) => route.abort());
  const asked = page.waitForRequest("**/api/auth/sign-in/social");
  const answered = page.waitForResponse("**/api/auth/sign-in/social");
  await page.getByRole("button", { name: "Google でログイン" }).click();
  expect((await answered).status(), "the server takes the way back").toBeLessThan(400);
  return (await asked).postDataJSON();
}

/** The text a way back carries to the quick note. */
const sharedIn = (path: string) => new URL(path, "http://localhost").searchParams.get("text");

test.describe("signing in from the quick note", () => {
  test("a share waits through sign-in, and comes back to the quick note", async ({ page }) => {
    const shared = `/quick?${new URLSearchParams({ text: "あとで読む https://example.com/a" })}`;
    await page.goto(shared);
    await expect(page).toHaveURL(/\/sign-in\?/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(shared);
    expect(await askedToComeBackTo(page)).toMatchObject({
      provider: "google",
      callbackURL: shared,
    });
  });

  test("whatever a share holds, a * of its Markdown included, it waits through sign-in", async ({
    page,
  }) => {
    const text = "**大事** (あとで) https://example.com/a?b=c";
    await page.goto(`/quick?${new URLSearchParams({ text })}`);
    await expect(page).toHaveURL(/\/sign-in\?/);
    const { callbackURL } = await askedToComeBackTo(page);
    expect(sharedIn(callbackURL)).toBe(text);
  });

  test("the notes send to sign in as well, to come back to them", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in\?/);
    expect(new URL(page.url()).searchParams.get("next")).toBe("/app");
    await expect(page.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  });

  test("is a redirect the service worker cannot mistake for the page", async ({ page }) => {
    // A page that sent onward from the browser would be kept as the offline copy.
    for (const address of ["/quick?text=abc", "/app"]) {
      const response = await page.request.get(address, { maxRedirects: 0 });
      expect(response.status(), address).toBe(307);
      const next = new URL(response.headers().location!, "http://localhost").searchParams.get(
        "next",
      );
      expect(next, address).toBe(address);
    }
  });

  test("the way back is the address itself, whatever the browser claims it to be", async ({
    page,
  }) => {
    // Claims that would pass as ways back, so only the proxy's own can win.
    for (const [address, claimed] of [
      ["/app?n=abc", "/quick?text=planted"],
      ["/quick?text=abc", "/app/settings"],
    ]) {
      const response = await page.request.get(address, {
        maxRedirects: 0,
        headers: { "x-memoca-asked-for": claimed },
      });
      const next = new URL(response.headers().location!, "http://localhost").searchParams.get(
        "next",
      );
      expect(next, address).toBe(address);
    }
  });

  test("a way back that leads off the site is not followed", async ({ page }) => {
    await page.goto(`/sign-in?${new URLSearchParams({ next: "//evil.example/steal" })}`);
    expect(await askedToComeBackTo(page)).toMatchObject({ callbackURL: "/app" });
  });
});
