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

  test("a way back that leads off the site is not followed", async ({ page }) => {
    await page.goto(`/sign-in?${new URLSearchParams({ next: "//evil.example/steal" })}`);
    expect(await askedToComeBackTo(page)).toMatchObject({ callbackURL: "/app" });
  });
});
