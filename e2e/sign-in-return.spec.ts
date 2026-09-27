import { expect, type Page, test } from "@playwright/test";

/** What the Google button asks the server to come back to, stopped before Google. */
async function askedToComeBackTo(page: Page): Promise<unknown> {
  const asked = page.waitForRequest("**/api/auth/sign-in/social");
  await page.route("**/api/auth/sign-in/social", (route) => route.abort());
  await page.getByRole("button", { name: "Google でログイン" }).click();
  return (await asked).postDataJSON();
}

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
    const response = await page.request.get("/app", {
      maxRedirects: 0,
      headers: { "x-memoca-asked-for": "//evil.example/steal" },
    });
    const next = new URL(response.headers().location!, "http://localhost").searchParams.get("next");
    expect(next).toBe("/app");
  });

  test("a way back that leads off the site is not followed", async ({ page }) => {
    await page.goto(`/sign-in?${new URLSearchParams({ next: "//evil.example/steal" })}`);
    expect(await askedToComeBackTo(page)).toMatchObject({ callbackURL: "/app" });
  });
});
