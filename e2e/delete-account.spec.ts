import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

/** The password every E2E account is made with (e2e/helpers.ts). */
const PASSWORD = "memoca-e2e-password";

test("an account deleted from the settings is gone with its sign-in: it cannot be signed in to again", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one is enough");
  const email = await signUp(page);
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "アカウントを削除" }).click();
  await page.getByRole("button", { name: "削除する" }).click();
  // Back at the start, signed out.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });

  // The sign-in itself gone: before, it stayed, and signed in as before.
  const status = await page.evaluate(
    async ([address, secret]) =>
      (
        await fetch("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: address, password: secret }),
        })
      ).status,
    [email, PASSWORD],
  );
  expect(status).toBeGreaterThanOrEqual(400);
});
