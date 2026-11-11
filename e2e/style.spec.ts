import { type Page, expect, test } from "@playwright/test";
import { openApp, signIn, signUp, waitForSynced } from "./helpers";

/** The app's looks (src/lib/style.ts), chosen in the settings for the account. */

const look = (page: Page) => page.evaluate(() => document.documentElement.dataset.style ?? "stylish");
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("a look chosen: the page in it at once, kept here from before it is drawn, and on the account's other devices", async ({
  page,
  context,
}, testInfo) => {
  const phone = testInfo.project.name === "mobile";
  const email = await signUp(page);
  await openApp(page);
  await page.goto("/app/settings");
  const looks = page.getByRole("radiogroup", { name: "デザイン" });
  await expect(looks.getByRole("radio", { name: /スタイリッシュ/ })).toHaveAttribute("aria-checked", "true");
  const before = await background(page);

  await looks.getByRole("radio", { name: /かわいい/ }).click();
  await expect(looks.getByRole("radio", { name: /かわいい/ })).toHaveAttribute("aria-checked", "true");
  expect(await look(page)).toBe("cute");
  expect(await background(page)).not.toBe(before);
  // The browser's bar in the page's colour.
  expect(await page.locator('meta[name="theme-color"]').first().getAttribute("content")).toBe(
    await background(page),
  );

  // Kept here: on as the page is first drawn, and no other after it (not
  // a copy of the account kept from before it was chosen).
  await expect.poll(() => page.evaluate(() => localStorage.getItem("memoca:style-sent"))).toBeNull();
  await page.addInitScript(() => {
    // The look as the page is parsed (before its scripts of the app's run),
    // and each it is put in after.
    const seen = window as unknown as { __looks: string[] };
    seen.__looks = [];
    document.addEventListener("DOMContentLoaded", () => {
      const now = () => document.documentElement.dataset.style ?? "stylish";
      seen.__looks.push(now());
      new MutationObserver(() => seen.__looks.push(now())).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-style"],
      });
    });
  });
  await page.goto("/app");
  await waitForSynced(page);
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => (window as unknown as { __looks: string[] }).__looks)).toEqual(["cute"]);

  // And on another device of the account.
  const fresh = await context.browser()!.newContext({
    viewport: page.viewportSize() ?? undefined,
    isMobile: phone,
    hasTouch: phone,
  });
  const other = await fresh.newPage();
  await signIn(other, email);
  await other.goto("/app");
  await waitForSynced(other);
  await expect.poll(() => look(other), { timeout: 15_000 }).toBe("cute");

  // Chosen there, here too, with this page as it is (not opened again).
  await other.goto("/app/settings");
  await other.getByRole("radiogroup", { name: "デザイン" }).getByRole("radio", { name: /レトロ/ }).click();
  expect(await look(other)).toBe("retro");
  await expect.poll(() => look(page), { timeout: 20_000 }).toBe("retro");
  // Heard back by the device that chose it: no longer kept to be sent.
  await expect.poll(() => other.evaluate(() => localStorage.getItem("memoca:style-sent"))).toBeNull();
  await fresh.close();

  // Back to the first: the page's own colours again.
  await page.goto("/app/settings");
  await page.getByRole("radiogroup", { name: "デザイン" }).getByRole("radio", { name: /スタイリッシュ/ }).click();
  expect(await look(page)).toBe("stylish");
  expect(await background(page)).toBe(before);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("memoca:style-sent"))).toBeNull();
  // Chosen again, the one the account has: nothing left to send.
  await page.getByRole("radiogroup", { name: "デザイン" }).getByRole("radio", { name: /スタイリッシュ/ }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("memoca:style-sent"))).toBeNull();
});
